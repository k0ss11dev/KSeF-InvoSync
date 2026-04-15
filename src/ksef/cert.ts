// SPDX-License-Identifier: GPL-3.0-or-later
// Fetch the KSeF public-key certificate list, pick the right one for token
// encryption, parse it, and import it as a CryptoKey ready for the
// /auth/ksef-token call.
//
// Selection rule (from the docs research, 2026-04-11):
//   Filter to certs whose `usage` contains "KsefTokenEncryption".
//   Filter to certs that are currently within their validFrom..validTo window.
//   If multiple are valid, pick the one with the latest `validFrom`.

import { log } from "../shared/logger";
import { extractSpkiFromCertBase64 } from "./asn1";
import type { PublicKeyCertificate } from "./types";

export type ImportedKsefKey = {
  publicKey: CryptoKey;
  validFrom: Date;
  validTo: Date;
  /** Original base64 cert string — kept for logging / debugging only. */
  rawCertificate: string;
};

/**
 * Fetch /security/public-key-certificates from a KSeF API base URL and
 * import the right public key. Used by production code.
 */
export async function fetchKsefTokenEncryptionKey(
  apiBaseUrl: string,
): Promise<ImportedKsefKey> {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/security/public-key-certificates`;
  log("info", "Fetching KSeF public-key certificates from", url);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GET ${url} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const certs = (await res.json()) as PublicKeyCertificate[];
  if (!Array.isArray(certs) || certs.length === 0) {
    throw new Error("KSeF returned an empty public-key certificate list");
  }

  return importKsefTokenEncryptionKey(certs);
}

/**
 * Pure variant: pick + import a key from a list of certs already in hand.
 * Tests use this directly so they don't depend on the network layer.
 */
export async function importKsefTokenEncryptionKey(
  certs: PublicKeyCertificate[],
): Promise<ImportedKsefKey> {
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
    throw new Error(
      "no valid KsefTokenEncryption certificate in the returned list " +
        `(checked ${certs.length} cert(s))`,
    );
  }

  const chosen = candidates[0];
  log(
    "info",
    `Using KsefTokenEncryption cert validFrom=${chosen.validFrom} validTo=${chosen.validTo}`,
  );

  const spki = extractSpkiFromCertBase64(chosen.certificate);

  const publicKey = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

  return {
    publicKey,
    validFrom: new Date(chosen.validFrom),
    validTo: new Date(chosen.validTo),
    rawCertificate: chosen.certificate,
  };
}

/**
 * Encrypt the KSeF token + timestamp envelope for /auth/ksef-token. The
 * KSeF docs specify the wire format precisely:
 *   - inner payload: `${ksefToken}|${timestampMs}` (UTF-8)
 *   - timestamp: integer Unix milliseconds (number of ms since 1970-01-01),
 *     formatted as a decimal string
 *   - encryption: RSA-OAEP with SHA-256 hash and MGF1
 *   - encoding of the ciphertext: standard base64 (NOT base64url)
 */
export async function encryptKsefTokenEnvelope(
  publicKey: CryptoKey,
  ksefToken: string,
  timestampMs: number,
): Promise<string> {
  const envelope = `${ksefToken}|${timestampMs}`;
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(envelope),
  );
  return bytesToBase64(new Uint8Array(ciphertext));
}

/** Standard base64 (NOT base64url) — KSeF docs are explicit about this. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
