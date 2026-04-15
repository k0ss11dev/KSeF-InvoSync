// SPDX-License-Identifier: GPL-3.0-or-later
// Pure crypto helpers for the KSeF token vault.
//
// Algorithms:
//  - Key derivation: PBKDF2-HMAC-SHA256, 310,000 iterations (OWASP 2023+ floor)
//  - Symmetric cipher: AES-GCM with a 256-bit key and a fresh 12-byte IV per
//    encryption. AES-GCM gives us authenticated encryption — a tampered or
//    wrong-key decrypt fails loudly via the auth tag, which is what makes the
//    "wrong passphrase" check work without us having to store a separate
//    verification value (though we do anyway for unlock probing — see vault.ts).
//
// Pure functions only. No browser APIs beyond what Node 20+ also exposes on
// globalThis (crypto.subtle, crypto.getRandomValues, TextEncoder, btoa).
// That makes everything in this file unit-testable under Node without a
// browser context.

const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH = "SHA-256";
const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12; // 96 bits is the AES-GCM recommended IV length
const SALT_LENGTH = 16; // 128 bits

export type Ciphertext = {
  iv: string; // base64url
  data: string; // base64url
};

export type VaultKey = CryptoKey;

// --- Random helpers ------------------------------------------------------

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

export function randomIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
}

// --- Key derivation ------------------------------------------------------

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<VaultKey> {
  if (!passphrase) {
    throw new Error("deriveKey: passphrase must be a non-empty string");
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    true, // extractable — needed to cache in chrome.storage.session across SW suspensions
    ["encrypt", "decrypt"],
  );
}

// --- Key serialization (for session cache) --------------------------------

export async function exportKeyToJwk(key: VaultKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importKeyFromJwk(jwk: JsonWebKey): Promise<VaultKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}

// --- Symmetric encryption ------------------------------------------------

export async function encryptString(
  key: VaultKey,
  plaintext: string,
): Promise<Ciphertext> {
  const iv = randomIv();
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    iv: base64urlEncode(iv),
    data: base64urlEncode(new Uint8Array(data)),
  };
}

export async function decryptString(
  key: VaultKey,
  ciphertext: Ciphertext,
): Promise<string> {
  const iv = base64urlDecode(ciphertext.iv);
  const data = base64urlDecode(ciphertext.data);
  // AES-GCM throws an OperationError on auth-tag mismatch — caller treats
  // this as "wrong key or tampered ciphertext".
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  return new TextDecoder().decode(plaintext);
}

// --- base64url codec -----------------------------------------------------
// Same shape as src/google/pkce.ts, duplicated here so the storage module
// has zero dependencies on the google module.

export function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(input: string): Uint8Array {
  // Restore padding and standard base64 chars before atob.
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Constants exported for vault.ts and tests --------------------------

export const CRYPTO_PARAMS = Object.freeze({
  PBKDF2_ITERATIONS,
  PBKDF2_HASH,
  AES_KEY_LENGTH,
  AES_IV_LENGTH,
  SALT_LENGTH,
});
