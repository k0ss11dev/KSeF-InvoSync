// SPDX-License-Identifier: GPL-3.0-or-later
// KSeF 2.0 token-based authentication orchestrator.
//
// Implements the four-call flow documented in
// https://github.com/CIRFMF/ksef-docs/blob/main/uwierzytelnianie.md:
//
//   1. GET  /security/public-key-certificates  → pick KsefTokenEncryption cert
//   2. POST /auth/challenge                    → get challenge + timestampMs
//   3. POST /auth/ksef-token                   → submit RSA-OAEP-encrypted
//                                                 envelope `${token}|${ts}`
//                                                 → receive authenticationToken (JWT)
//   4. POST /auth/token/redeem                 → exchange authenticationToken
//                                                 for accessToken + refreshToken
//
// All four calls are stateless from this module's POV — the caller is
// responsible for storing the resulting tokens (in the vault for the long-
// lived refresh token, in chrome.storage.session for the short-lived access
// token). This module is pure I/O orchestration.

import { log, redactBearerTokens } from "../shared/logger";
import {
  encryptKsefTokenEnvelope,
  fetchKsefTokenEncryptionKey,
} from "./cert";
import type {
  AuthChallengeResponse,
  AuthInitResponse,
  AuthStatusResponse,
  AuthTokenRefreshResponse,
  AuthTokensResponse,
  ContextIdentifier,
} from "./types";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 60; // 30 seconds total — fast tokens hit 200 on attempt 1

export type AuthenticatedSession = {
  referenceNumber: string;
  accessToken: { token: string; validUntil: string };
  refreshToken: { token: string; validUntil: string };
};

export type AuthenticateOpts = {
  apiBaseUrl: string;
  ksefToken: string;
  contextIdentifier: ContextIdentifier;
};

/**
 * Run the full token-based KSeF auth flow against the given API base URL.
 * Returns access + refresh tokens on success, throws on any HTTP failure.
 */
export async function authenticateWithKsefToken(
  opts: AuthenticateOpts,
): Promise<AuthenticatedSession> {
  const baseUrl = opts.apiBaseUrl.replace(/\/+$/, "");

  // Step 1: fetch the public-key cert and import it as a CryptoKey.
  const importedKey = await fetchKsefTokenEncryptionKey(baseUrl);

  // Step 2: ask for a challenge.
  const challenge = await postJson<AuthChallengeResponse>(
    `${baseUrl}/auth/challenge`,
  );
  log(
    "info",
    `KSeF challenge=${challenge.challenge} timestampMs=${challenge.timestampMs}`,
  );

  // Step 3: encrypt `${ksefToken}|${timestampMs}` and submit.
  const encryptedToken = await encryptKsefTokenEnvelope(
    importedKey.publicKey,
    opts.ksefToken,
    challenge.timestampMs,
  );

  const init = await postJson<AuthInitResponse>(
    `${baseUrl}/auth/ksef-token`,
    {
      body: {
        challenge: challenge.challenge,
        contextIdentifier: opts.contextIdentifier,
        encryptedToken,
      },
    },
  );
  log(
    "info",
    `KSeF authenticationToken issued, referenceNumber=${init.referenceNumber}`,
  );

  // Step 3.5: KSeF authenticates asynchronously. /auth/ksef-token returns
  // 202 Accepted with a temporary JWT but the actual token validation
  // happens in the background. We must poll /auth/{referenceNumber} until
  // status.code === 200 before /auth/token/redeem will work — otherwise
  // redeem returns 21301 "Brak autoryzacji". Without this step, the whole
  // flow looks like it works against a naive mock and breaks against the
  // real API. Verified against api-test.ksef.mf.gov.pl 2026-04-11.
  await pollAuthStatusUntilSuccess(
    baseUrl,
    init.referenceNumber,
    init.authenticationToken.token,
  );

  // Step 4: redeem the temporary authenticationToken for access + refresh
  // tokens. The Authorization: Bearer header carries the authenticationToken.
  const tokens = await postJson<AuthTokensResponse>(
    `${baseUrl}/auth/token/redeem`,
    {
      headers: {
        Authorization: `Bearer ${init.authenticationToken.token}`,
      },
    },
  );
  log("info", "KSeF access + refresh tokens received");

  return {
    referenceNumber: init.referenceNumber,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

/**
 * Use a refresh token to mint a new access token. The refresh token itself
 * is not rotated — it stays valid until its own validUntil expires.
 */
export async function refreshKsefAccessToken(opts: {
  apiBaseUrl: string;
  refreshToken: string;
}): Promise<{ accessToken: { token: string; validUntil: string } }> {
  const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/auth/token/refresh`;
  const response = await postJson<AuthTokenRefreshResponse>(url, {
    headers: { Authorization: `Bearer ${opts.refreshToken}` },
  });
  return { accessToken: response.accessToken };
}

/**
 * Revoke the current session. Per the KSeF docs, this invalidates the
 * refresh token bound to the session — existing access tokens stay valid
 * until their own expiry. Called from the popup's Disconnect button and
 * on extension uninstall to be a good citizen.
 */
export async function terminateKsefSession(opts: {
  apiBaseUrl: string;
  accessToken: string;
}): Promise<void> {
  const url = `${opts.apiBaseUrl.replace(/\/+$/, "")}/auth/sessions/current`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  // 200 OK or 204 No Content are both acceptable success codes per the spec.
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DELETE ${url} failed: ${res.status} ${res.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }
}

// --- Auth status polling -------------------------------------------------

async function pollAuthStatusUntilSuccess(
  baseUrl: string,
  referenceNumber: string,
  authenticationToken: string,
): Promise<void> {
  const url = `${baseUrl}/auth/${referenceNumber}`;

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authenticationToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GET ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
      );
    }

    const status = (await response.json()) as AuthStatusResponse;
    const code = status.status?.code ?? 0;
    const description = status.status?.description ?? "?";

    log("info", `KSeF auth status (attempt ${attempt}): code=${code} "${description}"`);

    if (code === 200) {
      return;
    }
    if (code >= 400) {
      const details = status.status?.details?.length
        ? ` — ${status.status.details.join("; ")}`
        : "";
      throw new Error(
        `KSeF authentication failed: code ${code} "${description}"${details}`,
      );
    }

    // 100 = "in progress" or any unrecognised non-terminal code → wait + retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `KSeF authentication did not reach success within ${POLL_MAX_ATTEMPTS} polls`,
  );
}

// --- HTTP helper ---------------------------------------------------------

type PostJsonOpts = {
  body?: unknown;
  headers?: Record<string, string>;
};

async function postJson<T>(url: string, opts: PostJsonOpts = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }

  return (await response.json()) as T;
}
