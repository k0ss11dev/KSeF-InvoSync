// SPDX-License-Identifier: GPL-3.0-or-later
// Local Node HTTP mock of the KSeF 2.0 API. Listens on a random localhost
// port, returns shapes that match the real OpenAPI spec, and decrypts the
// /auth/ksef-token request body with the test private key so tests can
// assert the wire format byte-for-byte.
//
// Endpoints implemented:
//   GET    /security/public-key-certificates  → returns the test cert
//   POST   /auth/challenge                    → returns a fixed challenge + now
//   POST   /auth/ksef-token                   → decrypts encryptedToken,
//                                                records the plaintext envelope
//                                                in `lastDecryptedTokenEnvelope`,
//                                                returns a fresh authenticationToken
//   POST   /auth/token/redeem                 → validates Authorization header,
//                                                returns fresh access + refresh tokens
//   POST   /auth/token/refresh                → validates refresh token bearer,
//                                                returns a new access token
//   DELETE /auth/sessions/current             → validates access token bearer,
//                                                revokes the session
//
// Endpoints to add in M1c:
//   POST   /invoices/query/metadata           → returns synthetic invoice list

import {
  constants as cryptoConstants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  TEST_CERT_DER_BASE64,
  TEST_PRIVATE_KEY_PKCS8_DER_BASE64,
} from "../fixtures/test-cert";

export type MockKsefServer = {
  /** Base URL the test should pass to the extension, e.g. http://127.0.0.1:54321 */
  url: string;
  /** Stop the server. */
  close: () => Promise<void>;
  /** The most recent plaintext envelope decrypted from /auth/ksef-token. */
  readonly lastDecryptedTokenEnvelope: string | null;
  /** Reset all in-memory state between tests. */
  reset: () => void;
  /**
   * Make the next /invoices/query/metadata response set `isTruncated: true`.
   * One-shot — clears itself after the next query response. Used by sub-turn 3
   * to force the client into the truncated-result error path.
   */
  forceTruncateNextQuery: () => void;
  /**
   * Snapshot of online sessions opened against this server, including each
   * session's decrypted invoice plaintexts. Lets upload tests assert on the
   * round-trip end-to-end (FA3Builder → AES encrypt → POST → mock decrypt
   * → matches original).
   */
  readonly onlineSessions: ReadonlyMap<string, MockOnlineSession>;
};

export type MockOnlineSession = {
  referenceNumber: string;
  /** Decrypted symmetric key (32 bytes) — set when session opens. */
  symmetricKey: Buffer;
  /** 16-byte IV from the open request. */
  iv: Buffer;
  status: "open" | "closed";
  uploadedInvoices: Array<{
    referenceNumber: string;
    /** Plaintext FA(3) XML after the mock decrypted it. */
    decryptedXml: string;
  }>;
};

type MockState = {
  lastDecryptedTokenEnvelope: string | null;
  /** Authentication tokens issued by /auth/ksef-token, not yet redeemed. */
  pendingAuthTokens: Set<string>;
  /** Active access tokens issued by /auth/token/redeem or /auth/token/refresh. */
  accessTokens: Set<string>;
  /** Active refresh tokens issued by /auth/token/redeem. */
  refreshTokens: Set<string>;
  /** One-shot flag that flips the next /invoices/query/metadata to truncated. */
  forceTruncateNextQuery: boolean;
  /** Online upload sessions, keyed by session referenceNumber. */
  onlineSessions: Map<string, MockOnlineSession>;
};

export async function startMockKsefServer(): Promise<MockKsefServer> {
  const privateKey = createPrivateKey({
    key: Buffer.from(TEST_PRIVATE_KEY_PKCS8_DER_BASE64, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const state: MockState = {
    lastDecryptedTokenEnvelope: null,
    pendingAuthTokens: new Set(),
    accessTokens: new Set(),
    refreshTokens: new Set(),
    forceTruncateNextQuery: false,
    onlineSessions: new Map(),
  };

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, privateKey, state).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "internal", detail: String(err) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock-ksef-server: failed to determine listen address");
  }
  // Match the real API: the /v2 prefix is part of the base URL per the
  // OpenAPI spec's `servers` block. Tests get the prefixed URL and the
  // request handler strips /v2 before matching paths.
  const url = `http://127.0.0.1:${address.port}/v2`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    get lastDecryptedTokenEnvelope() {
      return state.lastDecryptedTokenEnvelope;
    },
    reset() {
      state.lastDecryptedTokenEnvelope = null;
      state.pendingAuthTokens.clear();
      state.accessTokens.clear();
      state.refreshTokens.clear();
      state.forceTruncateNextQuery = false;
      state.onlineSessions.clear();
    },
    forceTruncateNextQuery() {
      state.forceTruncateNextQuery = true;
    },
    get onlineSessions() {
      return state.onlineSessions;
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  privateKey: KeyObject,
  state: MockState,
): Promise<void> {
  // Permissive CORS so the extension's service worker (with its own
  // chrome-extension:// origin) can reach us without preflight rejection.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Strip the /v2 prefix so the path matchers below stay clean. The mock
  // base URL includes /v2 to match the real API's `servers` block.
  const rawPath = (req.url ?? "").split("?")[0];
  const path = rawPath.startsWith("/v2") ? rawPath.slice("/v2".length) : rawPath;

  // --- /security/public-key-certificates ---------------------------------
  if (req.method === "GET" && path === "/security/public-key-certificates") {
    const now = new Date();
    const validFrom = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const validTo = new Date(now.getTime() + 365 * 24 * 3600_000).toISOString();
    res.statusCode = 200;
    res.end(
      JSON.stringify([
        {
          certificate: TEST_CERT_DER_BASE64,
          validFrom,
          validTo,
          usage: ["KsefTokenEncryption", "SymmetricKeyEncryption"],
        },
      ]),
    );
    return;
  }

  // --- /auth/challenge ---------------------------------------------------
  if (req.method === "POST" && path === "/auth/challenge") {
    const now = Date.now();
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        challenge: `MOCK-CR-${randomHex(8).toUpperCase()}`,
        timestamp: new Date(now).toISOString(),
        timestampMs: now,
        clientIp: "127.0.0.1",
      }),
    );
    return;
  }

  // --- GET /auth/{referenceNumber} (auth status polling) ----------------
  // KSeF authenticates asynchronously: clients must poll this endpoint
  // (using the authenticationToken JWT as Bearer) until status.code === 200
  // before calling /auth/token/redeem. The mock returns code 200 immediately
  // so production polling code iterates exactly once during tests.
  if (
    req.method === "GET" &&
    /^\/auth\/(?!sessions)[^/]+$/.test(path)
  ) {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.pendingAuthTokens.has(bearer)) {
      sendError(res, 401, "unknown authentication token");
      return;
    }
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        startDate: new Date().toISOString(),
        authenticationMethod: "Token",
        status: {
          code: 200,
          description: "Uwierzytelnianie zakończone sukcesem",
        },
      }),
    );
    return;
  }

  // --- /auth/ksef-token --------------------------------------------------
  if (req.method === "POST" && path === "/auth/ksef-token") {
    const bodyText = await readBody(req);
    let body: { challenge: string; encryptedToken: string };
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    if (!body.encryptedToken) {
      sendError(res, 400, "missing encryptedToken");
      return;
    }

    const ciphertext = Buffer.from(body.encryptedToken, "base64");
    let decrypted: Buffer;
    try {
      decrypted = privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        ciphertext,
      );
    } catch (err) {
      sendError(res, 400, "decryption failed", String(err));
      return;
    }

    state.lastDecryptedTokenEnvelope = decrypted.toString("utf8");

    const authToken = `mock.auth.${randomHex(16)}`;
    state.pendingAuthTokens.add(authToken);

    res.statusCode = 202;
    res.end(
      JSON.stringify({
        referenceNumber: `MOCK-REF-${randomHex(8).toUpperCase()}`,
        authenticationToken: {
          token: authToken,
          validUntil: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    );
    return;
  }

  // --- /auth/token/redeem ------------------------------------------------
  if (req.method === "POST" && path === "/auth/token/redeem") {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.pendingAuthTokens.has(bearer)) {
      sendError(res, 401, "unknown or already-redeemed authentication token");
      return;
    }
    // Single-use: remove from pending so a second redeem fails.
    state.pendingAuthTokens.delete(bearer);

    const accessToken = `mock.access.${randomHex(16)}`;
    const refreshToken = `mock.refresh.${randomHex(16)}`;
    state.accessTokens.add(accessToken);
    state.refreshTokens.add(refreshToken);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        accessToken: {
          token: accessToken,
          validUntil: new Date(Date.now() + 600_000).toISOString(),
        },
        refreshToken: {
          token: refreshToken,
          validUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
        },
      }),
    );
    return;
  }

  // --- /auth/token/refresh -----------------------------------------------
  if (req.method === "POST" && path === "/auth/token/refresh") {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.refreshTokens.has(bearer)) {
      sendError(res, 401, "unknown or revoked refresh token");
      return;
    }

    const newAccessToken = `mock.access.${randomHex(16)}`;
    state.accessTokens.add(newAccessToken);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        accessToken: {
          token: newAccessToken,
          validUntil: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    );
    return;
  }

  // --- DELETE /auth/sessions/current --------------------------------------
  if (req.method === "DELETE" && path === "/auth/sessions/current") {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.accessTokens.has(bearer)) {
      sendError(res, 401, "unknown access token");
      return;
    }
    // Per the docs: this invalidates the refresh token tied to the session,
    // existing access tokens remain valid until their own expiry. For the
    // mock we're not tracking the access ↔ refresh binding, so just clear
    // every refresh token (good enough for the e2e tests we have).
    state.refreshTokens.clear();
    res.statusCode = 204;
    res.end();
    return;
  }

  // --- POST /sessions/online ----------------------------------------------
  // Open an interactive upload session: decrypt the symmetric key with our
  // private key, store it + the IV against a fresh session reference number.
  if (req.method === "POST" && path === "/sessions/online") {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.accessTokens.has(bearer)) {
      sendError(res, 401, "unknown access token");
      return;
    }

    const bodyText = await readBody(req);
    let body: {
      formCode?: { systemCode?: string; schemaVersion?: string; value?: string };
      encryption?: { encryptedSymmetricKey?: string; initializationVector?: string };
    };
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    const wrappedKeyB64 = body.encryption?.encryptedSymmetricKey;
    const ivB64 = body.encryption?.initializationVector;
    if (!wrappedKeyB64 || !ivB64) {
      sendError(res, 400, "missing encryption.encryptedSymmetricKey or initializationVector");
      return;
    }

    let symmetricKey: Buffer;
    try {
      symmetricKey = privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(wrappedKeyB64, "base64"),
      );
    } catch (err) {
      sendError(res, 400, "RSA decryption of symmetric key failed", String(err));
      return;
    }

    if (symmetricKey.length !== 32) {
      sendError(
        res,
        400,
        `symmetric key must be 32 bytes (got ${symmetricKey.length})`,
      );
      return;
    }

    const iv = Buffer.from(ivB64, "base64");
    if (iv.length !== 16) {
      sendError(res, 400, `IV must be 16 bytes (got ${iv.length})`);
      return;
    }

    const sessionRef = `MOCK-SO-${randomHex(8).toUpperCase()}`;
    state.onlineSessions.set(sessionRef, {
      referenceNumber: sessionRef,
      symmetricKey,
      iv,
      status: "open",
      uploadedInvoices: [],
    });

    res.statusCode = 201;
    res.end(
      JSON.stringify({
        referenceNumber: sessionRef,
        validUntil: new Date(Date.now() + 4 * 3600_000).toISOString(),
      }),
    );
    return;
  }

  // --- POST /sessions/online/{ref}/invoices --------------------------------
  // Decrypt the AES-CBC ciphertext with the session's stored key + IV,
  // verify the SHA-256 hashes the client sent match what we computed,
  // store the decrypted XML so tests can assert on it.
  const uploadMatch = path.match(/^\/sessions\/online\/([^/]+)\/invoices$/);
  if (req.method === "POST" && uploadMatch) {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.accessTokens.has(bearer)) {
      sendError(res, 401, "unknown access token");
      return;
    }

    const sessionRef = decodeURIComponent(uploadMatch[1]);
    const session = state.onlineSessions.get(sessionRef);
    if (!session) {
      sendError(res, 404, `unknown session ${sessionRef}`);
      return;
    }
    if (session.status !== "open") {
      sendError(res, 400, `session ${sessionRef} is not open`);
      return;
    }

    const bodyText = await readBody(req);
    let body: {
      invoiceHash?: string;
      invoiceSize?: number;
      encryptedInvoiceHash?: string;
      encryptedInvoiceSize?: number;
      encryptedInvoiceContent?: string;
      offlineMode?: boolean;
    };
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    if (
      !body.encryptedInvoiceContent ||
      !body.invoiceHash ||
      !body.encryptedInvoiceHash ||
      typeof body.invoiceSize !== "number" ||
      typeof body.encryptedInvoiceSize !== "number"
    ) {
      sendError(res, 400, "missing required SendInvoiceRequest fields");
      return;
    }

    const ciphertext = Buffer.from(body.encryptedInvoiceContent, "base64");

    // Verify ciphertext hash + size match what the client sent.
    const computedCipherHash = createHash("sha256").update(ciphertext).digest("base64");
    if (computedCipherHash !== body.encryptedInvoiceHash) {
      sendError(
        res,
        400,
        `encryptedInvoiceHash mismatch: client sent ${body.encryptedInvoiceHash}, mock computed ${computedCipherHash}`,
      );
      return;
    }
    if (ciphertext.length !== body.encryptedInvoiceSize) {
      sendError(
        res,
        400,
        `encryptedInvoiceSize mismatch: client sent ${body.encryptedInvoiceSize}, ciphertext is ${ciphertext.length} bytes`,
      );
      return;
    }

    // Decrypt with the session's symmetric key + IV.
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-cbc", session.symmetricKey, session.iv);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      sendError(res, 400, "AES decryption failed", String(err));
      return;
    }

    // Verify plaintext hash + size match.
    const computedPlainHash = createHash("sha256").update(plaintext).digest("base64");
    if (computedPlainHash !== body.invoiceHash) {
      sendError(
        res,
        400,
        `invoiceHash mismatch: client sent ${body.invoiceHash}, mock computed ${computedPlainHash}`,
      );
      return;
    }
    if (plaintext.length !== body.invoiceSize) {
      sendError(
        res,
        400,
        `invoiceSize mismatch: client sent ${body.invoiceSize}, plaintext is ${plaintext.length} bytes`,
      );
      return;
    }

    const invoiceRef = `MOCK-EE-${randomHex(8).toUpperCase()}`;
    session.uploadedInvoices.push({
      referenceNumber: invoiceRef,
      decryptedXml: plaintext.toString("utf8"),
    });

    res.statusCode = 202;
    res.end(JSON.stringify({ referenceNumber: invoiceRef }));
    return;
  }

  // --- POST /sessions/online/{ref}/close ----------------------------------
  const closeMatch = path.match(/^\/sessions\/online\/([^/]+)\/close$/);
  if (req.method === "POST" && closeMatch) {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.accessTokens.has(bearer)) {
      sendError(res, 401, "unknown access token");
      return;
    }
    const sessionRef = decodeURIComponent(closeMatch[1]);
    const session = state.onlineSessions.get(sessionRef);
    if (!session) {
      sendError(res, 404, `unknown session ${sessionRef}`);
      return;
    }
    session.status = "closed";
    res.statusCode = 204;
    res.end();
    return;
  }

  // --- POST /invoices/query/metadata --------------------------------------
  if (req.method === "POST" && path === "/invoices/query/metadata") {
    const bearer = bearerFromHeaders(req);
    if (!bearer) {
      sendError(res, 401, "missing bearer token");
      return;
    }
    if (!state.accessTokens.has(bearer)) {
      sendError(res, 401, "unknown access token");
      return;
    }

    // Parse the body for date-range filtering. Loose validation — the
    // OpenAPI spec is the authoritative shape, and our typed client should
    // already produce something that matches.
    const bodyText = await readBody(req);
    let body: { subjectType?: string; dateRange?: { from?: string; to?: string } };
    try {
      body = JSON.parse(bodyText);
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    const fromMs = body?.dateRange?.from
      ? Date.parse(body.dateRange.from)
      : Number.NEGATIVE_INFINITY;
    const toMs = body?.dateRange?.to
      ? Date.parse(body.dateRange.to)
      : Number.POSITIVE_INFINITY;

    // Choose dataset based on subjectType: Subject2 (buyer) returns the
    // incoming dataset; everything else returns the outgoing dataset.
    const rawDataset =
      body?.subjectType === "Subject2"
        ? MOCK_INCOMING_INVOICE_DATASET
        : MOCK_INVOICE_DATASET;

    const dataset = rawDataset.filter((inv) => {
      const invMs = Date.parse(inv.permanentStorageDate);
      return invMs >= fromMs && invMs <= toMs;
    });

    // Parse pagination from query string. We're at /invoices/query/metadata
    // so a fake host is fine for URL parsing.
    const fullUrl = new URL(req.url ?? "/", "http://x");
    const pageOffset = Number(fullUrl.searchParams.get("pageOffset") ?? "0");
    const pageSize = Number(fullUrl.searchParams.get("pageSize") ?? "10");

    const start = pageOffset * pageSize;
    const end = Math.min(start + pageSize, dataset.length);
    const page = dataset.slice(start, end);

    // One-shot truncation flag. If set, the response says isTruncated=true
    // (regardless of whether the result actually exceeded any limit) and
    // the flag clears itself.
    let isTruncated = false;
    if (state.forceTruncateNextQuery) {
      isTruncated = true;
      state.forceTruncateNextQuery = false;
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        invoices: page,
        hasMore: end < dataset.length,
        isTruncated,
        permanentStorageHwmDate:
          page.length > 0
            ? page[page.length - 1].permanentStorageDate
            : new Date().toISOString(),
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found", path }));
}

// --- mock invoice dataset (30 deterministic invoices) ------------------
//
// Anchored relative to "now" at module load: i=0 → today, i=29 → 29 days
// ago. This means the SW's default 30-day lookback (in src/ksef/sync.ts)
// always covers the entire dataset, which matters for the popup-flow tests
// in sub-turn 3 (the popup doesn't expose date-range inputs and uses the
// SW's defaults).
//
// Existing M1c date-range tests use a wide window (2025-01-01 → 2026-12-31
// or 2030-* for the empty case), so they remain correct as long as the
// test process is running between 2025 and 2027.

const DATASET_ANCHOR_NOW = Date.now();
const MOCK_INVOICE_DATASET = generateMockInvoices(30, DATASET_ANCHOR_NOW);

// Subject2 (incoming / buyer) dataset: 10 invoices where the buyer NIP is
// the auth context NIP (5555555555). The seller is some other company.
// Timestamps offset by 12 hours so they don't collide with the outgoing set.
const MOCK_INCOMING_INVOICE_DATASET = generateMockIncomingInvoices(10, DATASET_ANCHOR_NOW);

function generateMockInvoices(
  n: number,
  nowMs: number,
): Array<{
  ksefNumber: string;
  invoiceNumber: string;
  issueDate: string;
  invoicingDate: string;
  acquisitionDate: string;
  permanentStorageDate: string;
  seller: { nip: string; name: string };
  buyer: { identifier: { type: string; value: string }; name: string };
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  currency: string;
  invoicingMode: string;
  invoiceType: string;
  hasAttachment: boolean;
}> {
  const result = [];
  for (let i = 0; i < n; i++) {
    // i=0 is "today", i=n-1 is "(n-1) days ago".
    const ts = new Date(nowMs - i * 24 * 3600_000);
    const net = 1000 + i * 13.37;
    const vat = +(net * 0.23).toFixed(2);
    result.push({
      ksefNumber: `5555555555-${ts.toISOString().slice(0, 10).replace(/-/g, "")}-MOCK${String(i).padStart(8, "0")}-E${(i % 10).toString(16).toUpperCase()}`,
      invoiceNumber: `FA/MOCK/${String(i + 1).padStart(4, "0")}`,
      issueDate: ts.toISOString().slice(0, 10),
      invoicingDate: ts.toISOString(),
      // Important: keep acquisition + permanentStorage AT or BEFORE `ts`, not
      // after. If they were even a few seconds after, the i=0 ("today") row
      // would land in the future and fall just outside the SW's default
      // 30-day lookback, giving 29 instead of 30.
      acquisitionDate: ts.toISOString(),
      permanentStorageDate: ts.toISOString(),
      seller: { nip: "5555555555", name: "Mock Seller Sp. z o.o." },
      buyer: {
        identifier: { type: "Nip", value: `${1000000000 + i}` },
        name: `Mock Buyer ${i + 1}`,
      },
      netAmount: +net.toFixed(2),
      vatAmount: vat,
      grossAmount: +(net + vat).toFixed(2),
      currency: "PLN",
      invoicingMode: i % 2 === 0 ? "Online" : "Offline",
      invoiceType: "Vat",
      hasAttachment: false,
    });
  }
  return result;
}

function generateMockIncomingInvoices(
  n: number,
  nowMs: number,
): Array<ReturnType<typeof generateMockInvoices>[number]> {
  const result = [];
  for (let i = 0; i < n; i++) {
    // 12h offset to avoid collisions with the outgoing set.
    const ts = new Date(nowMs - i * 24 * 3600_000 - 12 * 3600_000);
    const net = 2000 + i * 17.5;
    const vat = +(net * 0.23).toFixed(2);
    result.push({
      ksefNumber: `9999999999-${ts.toISOString().slice(0, 10).replace(/-/g, "")}-INCM${String(i).padStart(8, "0")}-F${(i % 10).toString(16).toUpperCase()}`,
      invoiceNumber: `FA/INCOMING/${String(i + 1).padStart(4, "0")}`,
      issueDate: ts.toISOString().slice(0, 10),
      invoicingDate: ts.toISOString(),
      acquisitionDate: ts.toISOString(),
      permanentStorageDate: ts.toISOString(),
      // SELLER is someone else; BUYER is us (5555555555).
      seller: { nip: "9999999999", name: `Mock Supplier ${i + 1}` },
      buyer: {
        identifier: { type: "Nip" as const, value: "5555555555" },
        name: "Our Company Sp. z o.o.",
      },
      netAmount: +net.toFixed(2),
      vatAmount: vat,
      grossAmount: +(net + vat).toFixed(2),
      currency: "PLN",
      invoicingMode: "Online" as const,
      invoiceType: "Vat",
      hasAttachment: false,
    });
  }
  return result;
}

// --- helpers --------------------------------------------------------------

function bearerFromHeaders(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? req.headers.Authorization;
  if (!auth || typeof auth !== "string") return null;
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim() || null;
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  detail?: string,
): void {
  res.statusCode = status;
  res.end(JSON.stringify({ error: message, ...(detail ? { detail } : {}) }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function randomHex(numBytes: number): string {
  return randomBytes(numBytes).toString("hex");
}
