#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Diagnostic: check KSeF session status + per-invoice processing status.
// Given one or more session reference numbers, authenticate with the
// SELLER token and query:
//   GET /sessions/{ref}  → overall session state + invoiceCount + successfulInvoiceCount
//   GET /sessions/{ref}/invoices        → per-invoice statuses
//   GET /sessions/{ref}/invoices/failed → failed invoice diagnostics
//
// Usage:
//   node scripts/check-session-status.mjs <session-ref> [<session-ref> ...]

import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const API_BASE = "https://api-test.ksef.mf.gov.pl/v2";
const TOKEN_FILE = resolve(ROOT, "tests/fixtures/real-ksef-token.local");

const sessionRefs = process.argv.slice(2);
if (sessionRefs.length === 0) {
  console.error("usage: node scripts/check-session-status.mjs <session-ref> [...]");
  process.exit(1);
}

// ==== re-use auth helpers from seed script ===============================
function parseTokenBundle(raw) {
  const parts = raw.trim().split("|");
  if (parts.length !== 3 || !parts[1].startsWith("nip-")) {
    throw new Error("bad token bundle format");
  }
  return { referenceNumber: parts[0], nip: parts[1].slice(4), token: raw.trim() };
}

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
function pickTokenEncryptionCert(certs) {
  const now = Date.now();
  const valid = certs
    .filter((c) => c.usage?.includes("KsefTokenEncryption"))
    .filter((c) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo))
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  if (!valid.length) throw new Error("no KsefTokenEncryption cert found");
  return extractSpkiFromCertBase64(valid[0].certificate);
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function postJson(url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function authenticate(tokenBundle) {
  const certs = await getJson(`${API_BASE}/security/public-key-certificates`);
  const spki = pickTokenEncryptionCert(certs);

  const chal = await postJson(`${API_BASE}/auth/challenge`);

  const envelope = `${tokenBundle.token}|${chal.timestampMs}`;
  const pubKey = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  const encrypted = publicEncrypt(
    { key: pubKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope),
  );

  const authStart = await postJson(`${API_BASE}/auth/ksef-token`, {
    body: {
      challenge: chal.challenge,
      contextIdentifier: { type: "Nip", value: tokenBundle.nip },
      encryptedToken: encrypted.toString("base64"),
    },
  });

  // poll
  let status;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = await getJson(`${API_BASE}/auth/${authStart.referenceNumber}`, {
      Authorization: `Bearer ${authStart.authenticationToken.token}`,
    });
    if (status.status?.code === 200) break;
  }
  if (status?.status?.code !== 200) throw new Error(`auth poll failed: ${JSON.stringify(status)}`);

  const redeem = await postJson(`${API_BASE}/auth/token/redeem`, {
    headers: { Authorization: `Bearer ${authStart.authenticationToken.token}` },
  });
  return redeem.accessToken.token;
}

// ==== main ==============================================================
const bundle = parseTokenBundle(readFileSync(TOKEN_FILE, "utf8"));
console.log(`Authenticating as NIP ${bundle.nip}...`);
const accessToken = await authenticate(bundle);
console.log("✓ authenticated\n");

for (const ref of sessionRefs) {
  console.log("=".repeat(70));
  console.log(`Session: ${ref}`);
  console.log("=".repeat(70));

  try {
    const info = await getJson(`${API_BASE}/sessions/${ref}`, {
      Authorization: `Bearer ${accessToken}`,
    });
    console.log(`  status:                ${info.status?.code} ${info.status?.description ?? ""}`);
    console.log(`  invoiceCount:          ${info.invoiceCount}`);
    console.log(`  successfulInvoiceCount: ${info.successfulInvoiceCount}`);
    if (info.failedInvoiceCount !== undefined) {
      console.log(`  failedInvoiceCount:    ${info.failedInvoiceCount}`);
    }
  } catch (err) {
    console.log(`  ✗ /sessions/${ref}: ${err.message}`);
  }

  try {
    const invs = await getJson(`${API_BASE}/sessions/${ref}/invoices`, {
      Authorization: `Bearer ${accessToken}`,
    });
    const list = invs.invoices ?? invs;
    console.log(`  /invoices → ${Array.isArray(list) ? list.length : "?"} entries`);
    if (Array.isArray(list)) {
      for (const inv of list) {
        console.log(
          `    - ${inv.invoiceNumber ?? inv.referenceNumber ?? "?"}  status=${inv.status?.code ?? "?"} ${inv.status?.description ?? ""}`,
        );
      }
    }
  } catch (err) {
    console.log(`  ✗ /invoices: ${err.message}`);
  }

  try {
    const failed = await getJson(`${API_BASE}/sessions/${ref}/invoices/failed`, {
      Authorization: `Bearer ${accessToken}`,
    });
    const fList = failed.invoices ?? failed;
    if (Array.isArray(fList) && fList.length) {
      console.log(`  FAILED invoices (${fList.length}):`);
      for (const f of fList) {
        console.log(`    - ${f.invoiceNumber ?? "?"}  ${f.status?.code} ${f.status?.description ?? ""}`);
        if (f.status?.details) console.log(`        details: ${JSON.stringify(f.status.details)}`);
      }
    }
  } catch (err) {
    console.log(`  (no /invoices/failed or empty: ${err.message})`);
  }
  console.log();
}
