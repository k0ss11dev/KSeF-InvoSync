// SPDX-License-Identifier: GPL-3.0-or-later
// Finding #7: error messages built from upstream HTTP response bodies can
// echo back bearer tokens / JWTs (for example a verbose 401 body that logs
// the rejected Authorization header). redactBearerTokens scrubs them before
// the string reaches the log buffer, devtools console, or a notification.

import { expect, test } from "@playwright/test";
import { redactBearerTokens } from "../../src/shared/logger";

test.describe("redactBearerTokens", () => {
  test("redacts bare 'Bearer eyJ…' with compact JWT payload", () => {
    const input =
      "401 Unauthorized: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abcDEF123456";
    expect(redactBearerTokens(input)).toBe("401 Unauthorized: [REDACTED]");
  });

  test("redacts lowercase 'bearer '", () => {
    expect(
      redactBearerTokens("got token: bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"),
    ).toBe("got token: [REDACTED]");
  });

  test("redacts a standalone JWT-shaped string even without the Bearer prefix", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig";
    expect(redactBearerTokens(`refresh rejected: ${jwt}`)).toBe(
      "refresh rejected: [REDACTED]",
    );
  });

  test("redacts multiple occurrences in one string", () => {
    const input =
      "old=Bearer eyJhbGciOiJSUzI1NiJ9.aaaaaaaaaaaaaaaaaaaaa new=eyJhbGciOiJSUzI1NiJ9.bbbbbbbbbbbbbbbbbbbbb";
    expect(redactBearerTokens(input)).toBe("old=[REDACTED] new=[REDACTED]");
  });

  test("does not touch normal error text", () => {
    expect(
      redactBearerTokens(
        '{"code":400,"message":"Zaplacono value not in enum"}',
      ),
    ).toBe('{"code":400,"message":"Zaplacono value not in enum"}');
  });

  test("does not touch short base64-ish tokens below the 20-char threshold", () => {
    // Too short to be a JWT payload → leave alone, avoid false positives.
    expect(redactBearerTokens("hash: eyJabc123")).toBe("hash: eyJabc123");
  });

  test("is case-insensitive on the 'Bearer' prefix", () => {
    expect(
      redactBearerTokens("BEARER eyJhbGciOiJIUzI1NiJ9.payload.sig"),
    ).toBe("[REDACTED]");
  });

  test("passes empty string through unchanged", () => {
    expect(redactBearerTokens("")).toBe("");
  });

  test("leaves plain status-code error messages untouched", () => {
    const msg = "POST https://ksef.mf.gov.pl/api/v2/foo failed: 500 Internal Server Error";
    expect(redactBearerTokens(msg)).toBe(msg);
  });
});
