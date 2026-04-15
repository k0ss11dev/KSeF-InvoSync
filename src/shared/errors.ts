// SPDX-License-Identifier: GPL-3.0-or-later
// Error taxonomy (M3 sub-turn 7). Classifies raw error strings from the
// service worker into categories, each with a user-friendly hint.
//
// Hints use chrome.i18n message keys so they get translated automatically.
// The `t()` call happens here at classify time, not at import time, so
// the locale is resolved when the error actually fires.

import { t } from "./i18n";

export type ErrorCategory =
  | "vault"
  | "ksef-auth"
  | "ksef-api"
  | "google-auth"
  | "google-api"
  | "network"
  | "unknown";

export type ClassifiedError = {
  category: ErrorCategory;
  /** Short user-friendly guidance. */
  hint: string;
  /** The original raw error message for debugging. */
  raw: string;
};

const RULES: Array<{
  test: (msg: string) => boolean;
  category: ErrorCategory;
  /** chrome.i18n message key — resolved lazily via t() in classifyError(). */
  hintKey: string;
}> = [
  // --- Vault ---
  { test: (m) => /vault is locked/i.test(m), category: "vault", hintKey: "error_hint_vault_locked" },
  { test: (m) => /vault not initialized|no ksef token|no context nip/i.test(m), category: "vault", hintKey: "error_hint_vault_not_init" },
  { test: (m) => /wrong passphrase/i.test(m), category: "vault", hintKey: "error_hint_wrong_passphrase" },

  // --- KSeF auth ---
  { test: (m) => /auth.*status.*450|błędnego tokenu/i.test(m), category: "ksef-auth", hintKey: "error_hint_ksef_token_invalid" },
  { test: (m) => /auth.*status.*400|auth.*failed|uwierzytelnianie.*niepowodzeniem/i.test(m), category: "ksef-auth", hintKey: "error_hint_ksef_auth_failed" },
  { test: (m) => /auth.*never reached success/i.test(m), category: "ksef-auth", hintKey: "error_hint_ksef_auth_timeout" },

  // --- KSeF API ---
  { test: (m) => /ksef.*truncated/i.test(m), category: "ksef-api", hintKey: "error_hint_ksef_truncated" },
  { test: (m) => /ksef|api-test\.ksef\.mf\.gov\.pl/i.test(m) && /5\d\d/.test(m), category: "ksef-api", hintKey: "error_hint_ksef_server_error" },

  // --- Google auth ---
  { test: (m) => /oauth.*cancel|oauth.*closed|launchwebauthflow/i.test(m), category: "google-auth", hintKey: "error_hint_google_cancelled" },
  { test: (m) => /oauth.*csrf|state mismatch/i.test(m), category: "google-auth", hintKey: "error_hint_google_csrf" },
  { test: (m) => /token exchange failed|refresh failed/i.test(m), category: "google-auth", hintKey: "error_hint_google_token_exchange" },
  { test: (m) => /not connected to google/i.test(m), category: "google-auth", hintKey: "error_hint_google_not_connected" },
  { test: (m) => /google_client_id not configured/i.test(m), category: "google-auth", hintKey: "error_hint_google_not_configured" },

  // --- Google API ---
  { test: (m) => /sheets\.googleapis|spreadsheets/i.test(m) && /4\d\d|5\d\d/.test(m), category: "google-api", hintKey: "error_hint_sheets_api" },
  { test: (m) => /drive.*4\d\d|drive.*5\d\d/i.test(m), category: "google-api", hintKey: "error_hint_drive_api" },

  // --- Network ---
  { test: (m) => /failed to fetch|networkerror|net::err|econnrefused|enotfound|timeout/i.test(m), category: "network", hintKey: "error_hint_network" },
];

/**
 * Classify a raw error string into a category with user-friendly guidance.
 * Rules are evaluated in order; first match wins. Unknown errors get a
 * generic "something went wrong" hint.
 */
export function classifyError(raw: string): ClassifiedError {
  for (const rule of RULES) {
    if (rule.test(raw)) {
      return { category: rule.category, hint: t(rule.hintKey), raw };
    }
  }
  return {
    category: "unknown",
    hint: t("error_hint_unknown"),
    raw,
  };
}
