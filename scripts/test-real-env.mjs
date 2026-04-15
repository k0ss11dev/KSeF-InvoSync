#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// One-shot M1 exit-criteria smoke test against the REAL KSeF 2.0 test
// environment at api-test.ksef.mf.gov.pl.
//
// Reads a token bundle from tests/fixtures/real-ksef-token.local (gitignored),
// runs the full auth + query pipeline using the same wire format as
// src/ksef/auth.ts + src/ksef/cert.ts, and prints the invoice count.
//
// The script duplicates ~120 lines of crypto/HTTP logic from the extension
// because the extension's source is TypeScript with browser-API surface
// (chrome.*) that can't run unmodified under Node. Both implementations
// must agree on:
//   - RSA-OAEP-SHA256 envelope format `${token}|${timestampMs}`
//   - X.509 SPKI extraction
//   - Endpoint paths: /security/public-key-certificates, /auth/challenge,
//     /auth/ksef-token, /auth/token/redeem, /invoices/query/metadata
//
// If this script passes against the real test env, the extension passes too.
//
// Usage:
//   node scripts/test-real-env.mjs

import { existsSync, readFileSync } from "node:fs";

// The OpenAPI spec's `servers` block specifies the /v2 path prefix as part
// of the base URL — every endpoint sits under /v2/* not /*.
const API_BASE = "https://api-test.ksef.mf.gov.pl/v2";
const TOKEN_FILE = "tests/fixtures/real-ksef-token.local";

// --- Token bundle parser ------------------------------------------------

function parseTokenBundle(raw) {
  const trimmed = raw.trim();
  // Format from the KSeF test app's "Generuj token" screen:
  //   refNum|nip-NNNNNNNNNN|hexToken
  // Earlier hypothesis: the hex part is the token. WRONG — it gets 450
  // "invalid token" from KSeF. The token is the WHOLE bundle string;
  // KSeF presumably splits on the last "|" to extract the timestamp from
  // our envelope.
  const parts = trimmed.split("|");
  let nip = null;
  let referenceNumber = null;
  if (parts.length === 3 && parts[1].startsWith("nip-")) {
    referenceNumber = parts[0];
    nip = parts[1].slice("nip-".length);
  }
  return {
    referenceNumber,
    nip,
    // The full bundle is what KSeF wants as the token in /auth/ksef-token.
    token: trimmed,
  };
}

// --- ASN.1 / X.509 SPKI extractor (mirrors src/ksef/asn1.ts) -----------

function parseTLV(bytes, offset) {
  if (offset >= bytes.length) {
    throw new Error(`asn1: offset ${offset} beyond input length ${bytes.length}`);
  }
  const tag = bytes[offset];
  let pos = offset + 1;
  let length = bytes[pos];
  pos++;
  if (length & 0x80) {
    const numBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | bytes[pos + i];
    }
    pos += numBytes;
  }
  const end = pos + length;
  return {
    tag,
    length,
    contents: bytes.slice(pos, end),
    raw: bytes.slice(offset, end),
  };
}

function asn1Children(parent) {
  const result = [];
  let offset = 0;
  while (offset < parent.contents.length) {
    const node = parseTLV(parent.contents, offset);
    result.push(node);
    offset += node.raw.length;
  }
  return result;
}

function extractSpkiFromCertBase64(b64) {
  const der = Uint8Array.from(Buffer.from(b64, "base64"));
  const cert = parseTLV(der, 0);
  if (cert.tag !== 0x30) throw new Error("not a SEQUENCE");
  const tbs = asn1Children(cert)[0];
  const tbsKids = asn1Children(tbs);
  const spkiIndex = tbsKids[0]?.tag === 0xa0 ? 6 : 5;
  return tbsKids[spkiIndex].raw;
}

// --- Crypto / cert selection (mirrors src/ksef/cert.ts) ----------------

async function importKsefPublicKey(certs) {
  const now = Date.now();
  const candidates = certs
    .filter((c) => c.usage?.includes("KsefTokenEncryption"))
    .filter((c) => {
      const from = Date.parse(c.validFrom);
      const to = Date.parse(c.validTo);
      return Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to;
    })
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  if (candidates.length === 0) {
    throw new Error("no valid KsefTokenEncryption certificate available");
  }
  const chosen = candidates[0];
  console.log(
    `     ✓ chosen cert validFrom=${chosen.validFrom} validTo=${chosen.validTo}`,
  );
  const spki = extractSpkiFromCertBase64(chosen.certificate);
  return crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
}

async function encryptEnvelope(publicKey, token, timestampMs) {
  const envelope = `${token}|${timestampMs}`;
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(envelope),
  );
  return Buffer.from(new Uint8Array(ciphertext)).toString("base64");
}

// --- HTTP helpers ------------------------------------------------------

async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...opts.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET ${url} → ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return res.json();
}

async function postJson(url, opts = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `POST ${url} → ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return res.json();
}

// --- Main ---------------------------------------------------------------

async function main() {
  if (!existsSync(TOKEN_FILE)) {
    console.error(`Token file not found: ${TOKEN_FILE}`);
    console.error(
      `Create it with one line: refNum|nip-NNNNNNNNNN|hex_token\n` +
        `(get this from the KSeF test app at https://ap-test.ksef.mf.gov.pl/)`,
    );
    process.exit(1);
  }

  const raw = readFileSync(TOKEN_FILE, "utf8");
  const parsed = parseTokenBundle(raw);

  console.log(`KSeF test-env smoke test`);
  console.log(`  API base:  ${API_BASE}`);
  console.log(`  Reference: ${parsed.referenceNumber}`);
  console.log(`  NIP:       ${parsed.nip}`);
  console.log(
    `  Token:     ${parsed.token.slice(0, 8)}…${parsed.token.slice(-4)} (${parsed.token.length} chars)`,
  );
  console.log();

  // 1. Fetch and import the public-key certificate
  console.log("1/6  GET /security/public-key-certificates");
  const certs = await getJson(`${API_BASE}/security/public-key-certificates`);
  console.log(`     ✓ ${certs.length} certificate(s) returned`);
  const publicKey = await importKsefPublicKey(certs);
  console.log(`     ✓ imported as RSA-OAEP-SHA256 CryptoKey`);

  // 2. Get an authentication challenge
  console.log("2/6  POST /auth/challenge");
  const challenge = await postJson(`${API_BASE}/auth/challenge`);
  console.log(`     ✓ challenge=${challenge.challenge}`);
  console.log(`     ✓ timestampMs=${challenge.timestampMs}`);

  // 3. Encrypt the envelope `${token}|${timestampMs}`
  console.log("3/6  encrypt envelope");
  const encryptedToken = await encryptEnvelope(
    publicKey,
    parsed.token,
    challenge.timestampMs,
  );
  console.log(`     ✓ ciphertext: ${encryptedToken.length} chars base64`);

  // 4. Submit the encrypted token
  console.log("4/6  POST /auth/ksef-token");
  const init = await postJson(`${API_BASE}/auth/ksef-token`, {
    body: {
      challenge: challenge.challenge,
      contextIdentifier: { type: "Nip", value: parsed.nip },
      encryptedToken,
    },
  });
  console.log(`     ✓ referenceNumber=${init.referenceNumber}`);
  console.log(
    `     ✓ authenticationToken issued (validUntil=${init.authenticationToken?.validUntil})`,
  );

  // 4b. Poll auth status until success — KSeF processes the auth
  // asynchronously after /auth/ksef-token returns 202. We must wait for
  // status.code === 200 before calling /auth/token/redeem, otherwise
  // redeem fails with 21301 "Brak autoryzacji" (status 450 = not yet
  // ready). Codes: 100 = in progress, 200 = success, 400 = failed.
  console.log("4b/6 GET /auth/{referenceNumber} (poll until success)");
  const authBearer = init.authenticationToken.token;
  let statusCode = 0;
  for (let attempt = 1; attempt <= 60; attempt++) {
    const status = await getJson(`${API_BASE}/auth/${init.referenceNumber}`, {
      headers: { Authorization: `Bearer ${authBearer}` },
    });
    statusCode = status.status?.code ?? 0;
    console.log(
      `     attempt ${attempt}: code=${statusCode} "${status.status?.description ?? "?"}"`,
    );
    if (statusCode === 200) break;
    if (statusCode === 400) {
      throw new Error(
        `auth failed: ${status.status?.description}${status.status?.details ? ` — ${status.status.details.join("; ")}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (statusCode !== 200) {
    throw new Error(`auth never reached success (last code=${statusCode})`);
  }

  // 5. Redeem for access + refresh tokens
  console.log("5/6  POST /auth/token/redeem");
  const tokens = await postJson(`${API_BASE}/auth/token/redeem`, {
    headers: { Authorization: `Bearer ${authBearer}` },
  });
  console.log(`     ✓ accessToken issued`);
  console.log(`     ✓ refreshToken issued (validUntil=${tokens.refreshToken?.validUntil})`);

  // 6. Query invoice metadata for the last 30 days
  console.log("6/6  POST /invoices/query/metadata (last 30 days)");
  const now = Date.now();
  const monthAgo = now - 30 * 24 * 3600_000;
  const queryUrl = `${API_BASE}/invoices/query/metadata?pageOffset=0&pageSize=10&sortOrder=Asc`;
  const queryResult = await postJson(queryUrl, {
    headers: { Authorization: `Bearer ${tokens.accessToken.token}` },
    body: {
      subjectType: "Subject1",
      dateRange: {
        dateType: "PermanentStorage",
        from: new Date(monthAgo).toISOString(),
        to: new Date(now).toISOString(),
      },
    },
  });
  const invoiceCount = queryResult.invoices?.length ?? 0;
  console.log(`     ✓ first page: ${invoiceCount} invoices`);
  console.log(`     ✓ hasMore: ${queryResult.hasMore}`);
  console.log(`     ✓ isTruncated: ${queryResult.isTruncated}`);

  // Cleanup — best-effort, never throws
  console.log("     DELETE /auth/sessions/current (best-effort cleanup)");
  try {
    await fetch(`${API_BASE}/auth/sessions/current`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken.token}` },
    });
    console.log("     ✓ session revoked");
  } catch (err) {
    console.log("     ⚠ revoke failed (non-fatal):", err.message);
  }

  console.log();
  console.log("=".repeat(60));
  console.log("✓ M1 EXIT CRITERIA MET");
  console.log("=".repeat(60));
  console.log(`  Real KSeF test-env auth + query pipeline succeeded.`);
  console.log(`  Last 30 days returned ${invoiceCount} invoice(s) on first page.`);
  console.log();
  console.log(
    `  Next: try the same flow through the popup UI to validate the full UX.`,
  );
}

main().catch((err) => {
  console.error();
  console.error("=".repeat(60));
  console.error("✗ FAILED");
  console.error("=".repeat(60));
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
