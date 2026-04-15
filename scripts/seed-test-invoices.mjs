#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Seed N test invoices into the real KSeF test environment.
//
// What this does (end-to-end against api-test.ksef.mf.gov.pl):
//   1. Read the KSeF token bundle from tests/fixtures/real-ksef-token.local
//   2. Authenticate (cert fetch → challenge → encrypt envelope → ksef-token
//      → poll auth status → redeem) — same flow as scripts/test-real-env.mjs
//   3. Open an interactive upload session with a fresh AES-256 key + IV
//      wrapped via RSA-OAEP-SHA256 (the same Node-crypto round-trip the
//      mock server validates in tests/e2e/ksef-upload.spec.ts)
//   4. Generate N test invoices via FA3Builder + generateTestInvoiceBatch
//      (the same TS modules covered by 48 unit tests in M3 sub-turn 4)
//   5. AES-256-CBC + PKCS#7 encrypt each invoice's XML and POST to
//      /sessions/online/{ref}/invoices
//   6. Close the session
//   7. Report KSeF reference numbers + how to verify they show up in
//      /invoices/query/metadata via the next sync
//
// Usage:
//   node scripts/seed-test-invoices.mjs            # default: 5 invoices
//   node scripts/seed-test-invoices.mjs 10         # 10 invoices
//
// The script bundles src/ksef/fa3-builder.ts + fa3-test-data.ts via
// esbuild on the fly (no separate build step) so the TS modules tested
// in Docker are the SAME modules driving the seed against real KSeF.

import * as esbuild from "esbuild";
import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const API_BASE = "https://api-test.ksef.mf.gov.pl/v2";
const TOKEN_FILE = resolve(ROOT, "tests/fixtures/real-ksef-token.local");
const DEFAULT_INVOICE_COUNT = 5;

// Parse CLI: [count] [--buyer-nip NNNNNNNNNN]
let invoiceCount = DEFAULT_INVOICE_COUNT;
let buyerNipOverride = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--buyer-nip" && process.argv[i + 1]) {
    buyerNipOverride = process.argv[++i];
  } else if (/^\d+$/.test(process.argv[i])) {
    invoiceCount = parseInt(process.argv[i], 10);
  }
}
if (!Number.isFinite(invoiceCount) || invoiceCount < 1 || invoiceCount > 100) {
  console.error(
    `usage: node scripts/seed-test-invoices.mjs [count] [--buyer-nip NIP]\n  count: 1-100, default ${DEFAULT_INVOICE_COUNT}`,
  );
  process.exit(1);
}

// =========================================================================
// Bundle the TS modules we need so the script uses the same code as the
// extension + Docker tests, with no manual duplication of FA3Builder logic.
// =========================================================================

async function loadFa3Modules() {
  const tmp = mkdtempSync(resolve(tmpdir(), "ksef-seed-"));
  const entryPath = resolve(tmp, "entry.ts");

  // Use ESM import from absolute paths so esbuild resolves them correctly.
  // The forward-slash-only POSIX path works on both Windows and Linux for
  // esbuild's path resolver.
  const builderPath = resolve(ROOT, "src/ksef/fa3-builder.ts").replace(/\\/g, "/");
  const testDataPath = resolve(ROOT, "src/ksef/fa3-test-data.ts").replace(/\\/g, "/");

  writeFileSync(
    entryPath,
    [
      `export { FA3Builder } from "${builderPath}";`,
      `export { generateTestInvoiceBatch } from "${testDataPath}";`,
    ].join("\n"),
  );

  const outFile = resolve(tmp, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    outfile: outFile,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
  });

  const mod = await import(`file://${outFile}`);
  return {
    FA3Builder: mod.FA3Builder,
    generateTestInvoiceBatch: mod.generateTestInvoiceBatch,
  };
}

// =========================================================================
// Token bundle parser (same as test-real-env.mjs)
// =========================================================================

function parseTokenBundle(raw) {
  const trimmed = raw.trim();
  const parts = trimmed.split("|");
  if (parts.length === 3 && parts[1].startsWith("nip-")) {
    return {
      referenceNumber: parts[0],
      nip: parts[1].slice("nip-".length),
      // KSeF wants the WHOLE bundle as the token in /auth/ksef-token, not
      // just the hex part. Discovered the hard way against real KSeF.
      token: trimmed,
    };
  }
  throw new Error(
    `Could not parse token bundle. Expected refNum|nip-NNNNNNNNNN|hexToken, got ${parts.length} parts.`,
  );
}

// =========================================================================
// ASN.1 SPKI extraction (mirror of src/ksef/asn1.ts — no shared module
// import because the script is plain JS for portability)
// =========================================================================

function parseTLV(bytes, offset) {
  const tag = bytes[offset];
  let pos = offset + 1;
  let length = bytes[pos];
  pos++;
  if (length & 0x80) {
    const numBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | bytes[pos + i];
    pos += numBytes;
  }
  return { tag, length, contents: bytes.slice(pos, pos + length), raw: bytes.slice(offset, pos + length) };
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
  const tbs = asn1Children(cert)[0];
  const tbsKids = asn1Children(tbs);
  const spkiIndex = tbsKids[0]?.tag === 0xa0 ? 6 : 5;
  return tbsKids[spkiIndex].raw;
}

// =========================================================================
// HTTP helpers
// =========================================================================

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
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
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// =========================================================================
// KSeF authentication flow (same as test-real-env.mjs)
// =========================================================================

function pickCert(certs, usage) {
  // KSeF returns multiple certs, each tagged with one or more `usage` values.
  // - "KsefTokenEncryption" — wraps the token in /auth/ksef-token
  // - "SymmetricKeyEncryption" — wraps the AES session key in /sessions/online
  // These are DIFFERENT keys; using the wrong one gives session status 415
  // ("Błąd odszyfrowania dostarczonego klucza"). Discovered the hard way
  // 2026-04-11 against the real test env.
  const now = Date.now();
  const candidates = certs
    .filter((c) => c.usage?.includes(usage))
    .filter((c) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo))
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  if (!candidates.length) {
    throw new Error(`no valid ${usage} cert in /security/public-key-certificates response`);
  }
  return extractSpkiFromCertBase64(candidates[0].certificate);
}

async function fetchKsefPublicKeysDer(certs) {
  return {
    tokenEncryption: pickCert(certs, "KsefTokenEncryption"),
    symmetricEncryption: pickCert(certs, "SymmetricKeyEncryption"),
  };
}

function nodeRsaEncrypt(spkiDer, plaintext) {
  // Node's createPublicKey accepts SPKI DER directly.
  const key = createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });
  return publicEncrypt(
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(plaintext),
  );
}

async function authenticate(parsedToken) {
  // 1. Fetch certs (both key types — auth uses one, sessions use the other)
  console.log("  • GET /security/public-key-certificates");
  const certs = await getJson(`${API_BASE}/security/public-key-certificates`);
  const keys = await fetchKsefPublicKeysDer(certs);

  // 2. Get challenge
  console.log("  • POST /auth/challenge");
  const challenge = await postJson(`${API_BASE}/auth/challenge`);

  // 3. Encrypt envelope `${token}|${timestampMs}` with the TOKEN-encryption key
  const envelope = `${parsedToken.token}|${challenge.timestampMs}`;
  const encrypted = nodeRsaEncrypt(keys.tokenEncryption, envelope).toString("base64");

  console.log("  • POST /auth/ksef-token");
  const init = await postJson(`${API_BASE}/auth/ksef-token`, {
    body: {
      challenge: challenge.challenge,
      contextIdentifier: { type: "Nip", value: parsedToken.nip },
      encryptedToken: encrypted,
    },
  });

  // 4. Poll auth status until success
  console.log("  • GET /auth/{ref} (poll)");
  for (let attempt = 1; attempt <= 60; attempt++) {
    const status = await getJson(`${API_BASE}/auth/${init.referenceNumber}`, {
      Authorization: `Bearer ${init.authenticationToken.token}`,
    });
    const code = status.status?.code ?? 0;
    if (code === 200) break;
    if (code >= 400) {
      throw new Error(
        `auth failed: code ${code} — ${status.status?.description}${status.status?.details ? ` (${status.status.details.join("; ")})` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 5. Redeem for access + refresh tokens
  console.log("  • POST /auth/token/redeem");
  const tokens = await postJson(`${API_BASE}/auth/token/redeem`, {
    headers: { Authorization: `Bearer ${init.authenticationToken.token}` },
  });

  return {
    accessToken: tokens.accessToken.token,
    refreshToken: tokens.refreshToken.token,
    // Returned as `keys` so the caller picks the right one for each operation.
    keys,
  };
}

// =========================================================================
// Upload session
// =========================================================================

async function openOnlineSession(accessToken, symmetricEncryptionSpkiDer) {
  // Generate fresh AES-256 key + 16-byte IV
  const symmetricKey = randomBytes(32);
  const iv = randomBytes(16);

  // RSA-OAEP-SHA256 wrap the AES key with KSeF's SymmetricKeyEncryption
  // public key (NOT the KsefTokenEncryption key — those are different
  // certs and using the wrong one gives session status 415).
  const encryptedKey = nodeRsaEncrypt(symmetricEncryptionSpkiDer, symmetricKey);

  console.log("  • POST /sessions/online");
  const response = await postJson(`${API_BASE}/sessions/online`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: {
      formCode: { systemCode: "FA (3)", schemaVersion: "1-0E", value: "FA" },
      encryption: {
        encryptedSymmetricKey: encryptedKey.toString("base64"),
        initializationVector: iv.toString("base64"),
      },
    },
  });

  return {
    referenceNumber: response.referenceNumber,
    validUntil: response.validUntil,
    symmetricKey,
    iv,
  };
}

async function uploadOneInvoice(accessToken, session, invoiceXml, indexLabel) {
  const plaintext = Buffer.from(invoiceXml, "utf8");
  const plaintextHash = createHash("sha256").update(plaintext).digest("base64");

  // AES-256-CBC + PKCS#7 (Node's default for createCipheriv aes-256-cbc)
  const cipher = createCipheriv("aes-256-cbc", session.symmetricKey, session.iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertextHash = createHash("sha256").update(ciphertext).digest("base64");

  const url = `${API_BASE}/sessions/online/${session.referenceNumber}/invoices`;
  console.log(`  • POST .../invoices  (${indexLabel}, plaintext ${plaintext.length}B → ciphertext ${ciphertext.length}B)`);

  const response = await postJson(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: {
      invoiceHash: plaintextHash,
      invoiceSize: plaintext.length,
      encryptedInvoiceHash: ciphertextHash,
      encryptedInvoiceSize: ciphertext.length,
      encryptedInvoiceContent: ciphertext.toString("base64"),
      offlineMode: false,
    },
  });

  return response.referenceNumber;
}

async function closeOnlineSession(accessToken, session) {
  console.log("  • POST .../close");
  await postJson(`${API_BASE}/sessions/online/${session.referenceNumber}/close`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  if (!existsSync(TOKEN_FILE)) {
    console.error(`Token file not found: ${TOKEN_FILE}`);
    console.error(
      `Create it with one line: refNum|nip-NNNNNNNNNN|hex_token\n` +
        `(get this from the KSeF test app at https://ap-test.ksef.mf.gov.pl/)`,
    );
    process.exit(1);
  }

  console.log(`KSeF FA(3) test invoice seeder`);
  console.log(`  API base: ${API_BASE}`);
  console.log(`  Invoices: ${invoiceCount}`);
  console.log();

  // Step 1: bundle the FA3Builder + test data factory from TypeScript source
  console.log("1/5  Bundling fa3-builder + fa3-test-data via esbuild...");
  const { FA3Builder, generateTestInvoiceBatch } = await loadFa3Modules();
  const builder = new FA3Builder();
  console.log("     ✓ ready");
  console.log();

  // Step 2: parse token + authenticate
  console.log("2/5  Authenticating...");
  const parsed = parseTokenBundle(readFileSync(TOKEN_FILE, "utf8"));
  console.log(`     NIP: ${parsed.nip}`);
  const auth = await authenticate(parsed);
  console.log("     ✓ authenticated");
  console.log();

  // Step 3: open upload session (uses the SymmetricKeyEncryption public key)
  console.log("3/5  Opening upload session...");
  const session = await openOnlineSession(auth.accessToken, auth.keys.symmetricEncryption);
  console.log(`     ✓ session ${session.referenceNumber}`);
  console.log(`     valid until ${session.validUntil}`);
  console.log();

  // Step 4: generate + upload invoices one at a time
  console.log(`4/5  Uploading ${invoiceCount} invoice(s)...`);
  // Seller = the authenticated NIP. Buyer is auto-generated unless
  // --buyer-nip was passed (used for cross-account incoming invoice tests).
  const baseSeed = Math.floor(Date.now() / 1000) % 1_000_000;
  const batchOpts = {
    seed: baseSeed,
    seller: { nip: parsed.nip },
  };
  if (buyerNipOverride) {
    batchOpts.buyer = { nip: buyerNipOverride };
  }
  const invoices = generateTestInvoiceBatch(invoiceCount, batchOpts);

  const invoiceRefs = [];
  for (let i = 0; i < invoices.length; i++) {
    const xml = builder.build(invoices[i]);

    // Dump every generated XML to disk for inspection. Helps debug
    // server-side validation failures (KSeF returns generic 500s with no
    // specific error code when its FA(3) XSD validator throws).
    const dumpPath = resolve(ROOT, `tests/fixtures/.seed-invoice-${i + 1}.local.xml`);
    writeFileSync(dumpPath, xml);
    console.log(`     dumped to ${dumpPath}`);

    const ref = await uploadOneInvoice(
      auth.accessToken,
      session,
      xml,
      `${i + 1}/${invoices.length} ${invoices[i].metadata.invoiceNumber}`,
    );
    invoiceRefs.push({
      invoiceNumber: invoices[i].metadata.invoiceNumber,
      referenceNumber: ref,
    });
  }
  console.log(`     ✓ all ${invoices.length} invoice(s) accepted`);
  console.log();

  // Step 5: close session
  console.log("5/5  Closing session...");
  try {
    await closeOnlineSession(auth.accessToken, session);
    console.log("     ✓ closed");
  } catch (err) {
    console.log(`     ⚠ close failed (non-fatal): ${err.message}`);
  }
  console.log();

  // Summary
  console.log("=".repeat(70));
  console.log("✓ DONE");
  console.log("=".repeat(70));
  console.log(`  Session: ${session.referenceNumber}`);
  console.log(`  ${invoiceRefs.length} invoice(s) submitted to KSeF test env:`);
  for (const r of invoiceRefs) {
    console.log(`    ${r.invoiceNumber.padEnd(40)} → ${r.referenceNumber}`);
  }
  console.log();
  console.log("  KSeF processes invoices asynchronously after acceptance.");
  console.log("  Wait ~30 seconds, then run the popup's Sync now button to see them");
  console.log("  appear in your Google Sheet (the count should jump by " + invoiceRefs.length + ").");
  console.log();
  console.log(
    "  Or re-run scripts/test-real-env.mjs and the count on the last line should be:",
  );
  console.log(`    previous_count + ${invoiceRefs.length}`);
}

main().catch((err) => {
  console.error();
  console.error("=".repeat(70));
  console.error("✗ FAILED");
  console.error("=".repeat(70));
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
