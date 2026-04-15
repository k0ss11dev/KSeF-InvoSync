// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the PKCE helpers. Runs under Playwright's Node test runner
// with no browser context — pkce.ts uses only Web Crypto APIs that Node 20+
// exposes on globalThis.

import { test, expect } from "@playwright/test";
import {
  base64url,
  generateCodeVerifier,
  sha256Base64Url,
} from "../../src/google/pkce";

test.describe("base64url", () => {
  test("encodes without padding, +, or /", () => {
    const bytes = new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa]);
    const encoded = base64url(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("encodes empty input to empty string", () => {
    expect(base64url(new Uint8Array([]))).toBe("");
  });

  test("encodes a single byte correctly", () => {
    // 0x00 → "AA" in standard base64, which is already URL-safe.
    expect(base64url(new Uint8Array([0x00]))).toBe("AA");
  });
});

test.describe("generateCodeVerifier", () => {
  test("produces 43-character URL-safe strings (32 bytes → base64url)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBe(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("produces unique values on each call", () => {
    const values = new Set<string>();
    for (let i = 0; i < 20; i++) {
      values.add(generateCodeVerifier());
    }
    expect(values.size).toBe(20);
  });
});

test.describe("sha256Base64Url", () => {
  // RFC 7636 Appendix B test vector:
  //   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  test("matches RFC 7636 test vector", async () => {
    const challenge = await sha256Base64Url(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("round-trips generateCodeVerifier output to a 43-char challenge", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await sha256Base64Url(verifier);
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
