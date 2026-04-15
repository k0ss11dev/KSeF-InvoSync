// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the vault's pure crypto helpers. Runs under Playwright's
// Node test runner with no browser context.

import { expect, test } from "@playwright/test";
import {
  base64urlDecode,
  base64urlEncode,
  decryptString,
  deriveKey,
  encryptString,
  randomIv,
  randomSalt,
} from "../../src/storage/crypto";

const PASSPHRASE = "correct horse battery staple";
const WRONG_PASSPHRASE = "incorrect horse battery staple";
const PLAINTEXT = "this is a KSeF test-env token: AAAA-BBBB-CCCC-DDDD";

test.describe("base64url codec", () => {
  test("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([
      0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe, 0x42, 0x13, 0x37, 0xab,
    ]);
    const encoded = base64urlEncode(original);
    const decoded = base64urlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  test("round-trips empty bytes", () => {
    expect(Array.from(base64urlDecode(base64urlEncode(new Uint8Array([]))))).toEqual([]);
  });

  test("decodes a value without padding", () => {
    // "f" → "Zg" (no padding) in base64url
    const decoded = base64urlDecode("Zg");
    expect(new TextDecoder().decode(decoded)).toBe("f");
  });
});

test.describe("randomSalt and randomIv", () => {
  test("randomSalt returns 16 bytes", () => {
    expect(randomSalt().length).toBe(16);
  });

  test("randomIv returns 12 bytes", () => {
    expect(randomIv().length).toBe(12);
  });

  test("two salts are not equal", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

test.describe("deriveKey", () => {
  test("is deterministic for the same passphrase + salt", async () => {
    const salt = new Uint8Array(16).fill(0x42);
    const k1 = await deriveKey(PASSPHRASE, salt);
    const k2 = await deriveKey(PASSPHRASE, salt);
    // Compare by encrypting the same plaintext with each key with the same IV
    // and checking the ciphertexts match.
    const fixedIv = new Uint8Array(12).fill(0x07);
    const ct1 = await crypto.subtle.encrypt({ name: "AES-GCM", iv: fixedIv }, k1, new TextEncoder().encode("hello"));
    const ct2 = await crypto.subtle.encrypt({ name: "AES-GCM", iv: fixedIv }, k2, new TextEncoder().encode("hello"));
    expect(Array.from(new Uint8Array(ct1))).toEqual(Array.from(new Uint8Array(ct2)));
  });

  test("rejects an empty passphrase", async () => {
    await expect(deriveKey("", randomSalt())).rejects.toThrow();
  });
});

test.describe("encrypt/decrypt round trip", () => {
  test("decrypts what it encrypted", async () => {
    const key = await deriveKey(PASSPHRASE, randomSalt());
    const ciphertext = await encryptString(key, PLAINTEXT);
    const decrypted = await decryptString(key, ciphertext);
    expect(decrypted).toBe(PLAINTEXT);
  });

  test("produces different ciphertexts on each call (fresh IV)", async () => {
    const key = await deriveKey(PASSPHRASE, randomSalt());
    const c1 = await encryptString(key, PLAINTEXT);
    const c2 = await encryptString(key, PLAINTEXT);
    expect(c1.iv).not.toBe(c2.iv);
    expect(c1.data).not.toBe(c2.data);
  });

  test("decryption fails with the wrong key", async () => {
    const salt = randomSalt();
    const rightKey = await deriveKey(PASSPHRASE, salt);
    const wrongKey = await deriveKey(WRONG_PASSPHRASE, salt);
    const ciphertext = await encryptString(rightKey, PLAINTEXT);
    await expect(decryptString(wrongKey, ciphertext)).rejects.toThrow();
  });

  test("decryption fails when ciphertext is tampered", async () => {
    const key = await deriveKey(PASSPHRASE, randomSalt());
    const ciphertext = await encryptString(key, PLAINTEXT);
    // Flip one base64url character in the data — AES-GCM auth tag should reject.
    const tampered = {
      iv: ciphertext.iv,
      data: ciphertext.data.slice(0, -2) + (ciphertext.data.slice(-2) === "AA" ? "BB" : "AA"),
    };
    await expect(decryptString(key, tampered)).rejects.toThrow();
  });

  test("decryption fails when IV is tampered", async () => {
    const key = await deriveKey(PASSPHRASE, randomSalt());
    const ciphertext = await encryptString(key, PLAINTEXT);
    const tampered = {
      iv: ciphertext.iv.slice(0, -2) + (ciphertext.iv.slice(-2) === "AA" ? "BB" : "AA"),
      data: ciphertext.data,
    };
    await expect(decryptString(key, tampered)).rejects.toThrow();
  });
});
