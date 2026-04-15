// SPDX-License-Identifier: GPL-3.0-or-later
// M3 sub-turn 7: unit tests for the error classifier.
// In Node (unit tests), chrome.i18n is unavailable, so t() falls back to
// the message key. Tests assert on the key to verify correct classification.

import { expect, test } from "@playwright/test";
import { classifyError, type ErrorCategory } from "../../src/shared/errors";

test.describe("classifyError", () => {
  // [input error string, expected category, expected hint key pattern]
  const cases: Array<[string, ErrorCategory, string]> = [
    // vault
    ["Vault is locked. Unlock with your passphrase first.", "vault", "error_hint_vault_locked"],
    ["vault not initialized — call create() first", "vault", "error_hint_vault_not_init"],
    ["No KSeF token stored in the vault.", "vault", "error_hint_vault_not_init"],
    ["No context NIP stored in the vault.", "vault", "error_hint_vault_not_init"],
    ["Wrong passphrase.", "vault", "error_hint_wrong_passphrase"],

    // ksef-auth
    ["Auth status check: code=450 (token rejected)", "ksef-auth", "error_hint_ksef_token_invalid"],
    ["Auth never reached success (last code=100)", "ksef-auth", "error_hint_ksef_auth_timeout"],
    ["Auth status: code=400 Uwierzytelnianie zakończone niepowodzeniem", "ksef-auth", "error_hint_ksef_auth_failed"],

    // ksef-api
    ["KSeF query result truncated", "ksef-api", "error_hint_ksef_truncated"],
    ["POST https://api-test.ksef.mf.gov.pl/v2/invoices failed: 500", "ksef-api", "error_hint_ksef_server_error"],

    // google-auth
    ["OAuth flow cancelled or closed", "google-auth", "error_hint_google_cancelled"],
    ["OAuth state mismatch — possible CSRF", "google-auth", "error_hint_google_csrf"],
    ["Token exchange failed (400): invalid_grant", "google-auth", "error_hint_google_token_exchange"],
    ["Refresh failed (401): invalid_client", "google-auth", "error_hint_google_token_exchange"],
    ["Not connected to Google", "google-auth", "error_hint_google_not_connected"],

    // google-api
    ["POST https://sheets.googleapis.com/v4/spreadsheets failed: 403", "google-api", "error_hint_sheets_api"],
    ["GET https://www.googleapis.com/drive/v3/files failed: 401", "google-api", "error_hint_drive_api"],

    // network
    ["Failed to fetch", "network", "error_hint_network"],
    ["TypeError: NetworkError when attempting to fetch", "network", "error_hint_network"],
    ["net::ERR_CONNECTION_REFUSED", "network", "error_hint_network"],

    // unknown
    ["Something completely unexpected happened", "unknown", "error_hint_unknown"],
  ];

  for (const [input, expectedCategory, expectedHintKey] of cases) {
    test(`"${input.slice(0, 60)}…" → ${expectedCategory}`, () => {
      const result = classifyError(input);
      expect(result.category).toBe(expectedCategory);
      // In Node, t() falls back to the key name since chrome.i18n is unavailable.
      expect(result.hint).toBe(expectedHintKey);
      expect(result.raw).toBe(input);
    });
  }
});
