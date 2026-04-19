// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the hand-rolled ASN.1 / X.509 SPKI extractor. The most
// important test is the "matches openssl output" round-trip — if the parser
// drifts from openssl's view of the same cert, every downstream RSA
// encryption against that key will silently produce garbage.

import { expect, test } from "@playwright/test";
import {
  children,
  extractSpkiFromCertBase64,
  extractSpkiFromCertDer,
  extractSpkiFromCertPem,
  parseTLV,
} from "../../src/ksef/asn1";
import {
  TEST_CERT_DER_BASE64,
  TEST_SPKI_DER_BASE64,
} from "../fixtures/test-cert";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

test.describe("parseTLV", () => {
  test("decodes a short-form SEQUENCE", () => {
    // SEQUENCE (3 bytes): { INTEGER 5 }
    const bytes = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x05]);
    const node = parseTLV(bytes, 0);
    expect(node.tag).toBe(0x30);
    expect(node.length).toBe(3);
    expect(node.contents.length).toBe(3);
    expect(node.raw.length).toBe(5);
  });

  test("decodes long-form length (1 byte)", () => {
    // SEQUENCE { 200 zero bytes }, length encoded as 0x81 0xc8
    const bytes = new Uint8Array(203);
    bytes[0] = 0x30;
    bytes[1] = 0x81;
    bytes[2] = 0xc8;
    const node = parseTLV(bytes, 0);
    expect(node.tag).toBe(0x30);
    expect(node.length).toBe(200);
    expect(node.contents.length).toBe(200);
    expect(node.raw.length).toBe(203);
  });

  test("decodes long-form length (2 bytes)", () => {
    // SEQUENCE { 256 zero bytes }, length encoded as 0x82 0x01 0x00
    const bytes = new Uint8Array(260);
    bytes[0] = 0x30;
    bytes[1] = 0x82;
    bytes[2] = 0x01;
    bytes[3] = 0x00;
    const node = parseTLV(bytes, 0);
    expect(node.tag).toBe(0x30);
    expect(node.length).toBe(256);
  });

  test("rejects truncated input", () => {
    expect(() => parseTLV(new Uint8Array([0x30]), 0)).toThrow(/truncated/);
    expect(() => parseTLV(new Uint8Array([0x30, 0x05, 0x01]), 0)).toThrow(
      /exceeds input bounds/,
    );
  });

  test("rejects indefinite-length form", () => {
    // Tag 0x30, length 0x80 = indefinite (BER only, not allowed in DER)
    expect(() => parseTLV(new Uint8Array([0x30, 0x80, 0x00, 0x00]), 0)).toThrow(
      /indefinite-length/,
    );
  });

  // -----------------------------------------------------------------
  // Finding #3: 32-bit bitwise overflow in long-form length decoding.
  // The old `length = (length << 8) | byte` loop produced negative
  // numbers for 4-byte lengths with the top bit set, and `bytes.slice`
  // silently returned an empty array. Parser now uses arithmetic
  // (length * 256 + byte) and caps at 10 MB.
  // -----------------------------------------------------------------

  test("rejects 4-byte length with top bit set (would overflow << in legacy code)", () => {
    // Tag 0x30, length 0x84 0x80 0x00 0x00 0x00 → 2^31 bytes declared
    const bytes = new Uint8Array([0x30, 0x84, 0x80, 0x00, 0x00, 0x00]);
    expect(() => parseTLV(bytes, 0)).toThrow(/length|exceeds/);
  });

  test("rejects 4-byte length near UInt32 max", () => {
    // Tag 0x30, length 0x84 0xff 0xff 0xff 0xff → 2^32 - 1 bytes declared
    const bytes = new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]);
    expect(() => parseTLV(bytes, 0)).toThrow(/length|exceeds/);
  });

  test("accepts legitimate 3-byte long-form length (arithmetic regression check)", () => {
    // Tag 0x30, length 0x83 0x01 0x00 0x00 → 65536 zero bytes
    const bytes = new Uint8Array(5 + 65536);
    bytes[0] = 0x30;
    bytes[1] = 0x83;
    bytes[2] = 0x01;
    bytes[3] = 0x00;
    bytes[4] = 0x00;
    const node = parseTLV(bytes, 0);
    expect(node.tag).toBe(0x30);
    expect(node.length).toBe(65536);
  });
});

test.describe("children", () => {
  test("walks all child TLVs of a SEQUENCE", () => {
    // SEQUENCE { INTEGER 1, INTEGER 2, INTEGER 3 }
    const bytes = new Uint8Array([
      0x30, 0x09, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x02, 0x01, 0x03,
    ]);
    const seq = parseTLV(bytes, 0);
    const kids = children(seq);
    expect(kids.length).toBe(3);
    expect(kids[0].contents[0]).toBe(1);
    expect(kids[1].contents[0]).toBe(2);
    expect(kids[2].contents[0]).toBe(3);
  });

  test("returns empty for an empty SEQUENCE", () => {
    const seq = parseTLV(new Uint8Array([0x30, 0x00]), 0);
    expect(children(seq)).toEqual([]);
  });
});

test.describe("extractSpkiFromCertBase64 — the critical path", () => {
  test("extracts SPKI from the test cert byte-for-byte matching openssl", () => {
    const spki = extractSpkiFromCertBase64(TEST_CERT_DER_BASE64);
    const spkiBase64 = bytesToBase64(spki);
    expect(spkiBase64).toBe(TEST_SPKI_DER_BASE64);
  });

  test("extracted SPKI is importable as an RSA-OAEP-SHA256 public key", async () => {
    const spki = extractSpkiFromCertBase64(TEST_CERT_DER_BASE64);
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    expect(key.algorithm.name).toBe("RSA-OAEP");
    expect(key.usages).toContain("encrypt");
  });

  test("imported key actually encrypts something (round-trip via SubtleCrypto)", async () => {
    const spki = extractSpkiFromCertBase64(TEST_CERT_DER_BASE64);
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      key,
      new TextEncoder().encode("hello-ksef-test"),
    );
    // RSA-2048 OAEP-SHA256 ciphertext is exactly 256 bytes.
    expect(ciphertext.byteLength).toBe(256);
  });
});

test.describe("extractSpkiFromCertPem", () => {
  test("strips PEM markers and decodes the same SPKI", () => {
    // Build a PEM by wrapping the base64 cert at 64-char lines.
    const lines: string[] = [];
    for (let i = 0; i < TEST_CERT_DER_BASE64.length; i += 64) {
      lines.push(TEST_CERT_DER_BASE64.slice(i, i + 64));
    }
    const pem =
      "-----BEGIN CERTIFICATE-----\n" +
      lines.join("\n") +
      "\n-----END CERTIFICATE-----\n";

    const spki = extractSpkiFromCertPem(pem);
    expect(bytesToBase64(spki)).toBe(TEST_SPKI_DER_BASE64);
  });
});

test.describe("extractSpkiFromCertDer rejects bad input", () => {
  test("throws on a non-SEQUENCE input", () => {
    expect(() => extractSpkiFromCertDer(new Uint8Array([0x02, 0x01, 0x05]))).toThrow(
      /expected outer Certificate to be SEQUENCE/,
    );
  });
});
