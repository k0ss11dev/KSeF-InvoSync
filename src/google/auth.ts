// SPDX-License-Identifier: GPL-3.0-or-later
// Google OAuth 2.0 Authorization Code flow with PKCE.
//
// Uses chrome.identity.launchWebAuthFlow for the redirect, which works in
// Chrome and Firefox (Firefox routes through *.extensions.allizom.org, Chrome
// through *.chromiumapp.org — both returned by chrome.identity.getRedirectURL).
//
// Security notes:
//  - PKCE code_verifier is the real protection: 32 random bytes, SHA-256 challenge.
//  - A CSRF `state` parameter is generated independently and verified on callback.
//  - Tokens stored in chrome.storage.local so they survive browser restart
//    (M3 sub-turn 5). The refresh token enables auto-sync across sessions.
//  - Threat model: chrome.storage.local is readable by anything with process
//    access — same as for the spreadsheet ID. The refresh token can be
//    revoked from the Google Account page at any time.
//  - Client secret (if set) is sent as part of the token exchange, but for
//    "Desktop app" / "Installed app" OAuth clients Google treats this secret
//    as a public identifier, per their OAuth-for-installed-apps docs.
//    See README → "OAuth setup" for which client type to create.

import { log } from "../shared/logger";
import { base64url, generateCodeVerifier, sha256Base64Url } from "./pkce";

const CLIENT_ID = __GOOGLE_CLIENT_ID__;
const CLIENT_SECRET = __GOOGLE_CLIENT_SECRET__;

const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar.events",
  // Narrow read-only scope to populate the calendar picker UI. Required
  // because `calendar.events` alone cannot list the user's calendarList.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");

const STORAGE_KEY = "google.token";

export type GoogleToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
  /** Refresh token for offline access. Present after `access_type=offline` consent. */
  refreshToken?: string;
};

export async function startGoogleAuth(): Promise<GoogleToken> {
  if (!CLIENT_ID) {
    throw new Error(
      "GOOGLE_CLIENT_ID not configured at build time. Copy .env.example → .env, " +
        'fill in your Google OAuth credentials, then run "npm run build" again. ' +
        'See README → "OAuth setup".',
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  log("info", "OAuth redirect URI (register this in Google Cloud Console):", redirectUri);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateCodeVerifier();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");

  const responseUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message ?? "launchWebAuthFlow failed"));
          return;
        }
        if (!resp) {
          reject(new Error("OAuth flow cancelled or closed"));
          return;
        }
        resolve(resp);
      },
    );
  });

  const parsed = new URL(responseUrl);

  const returnedState = parsed.searchParams.get("state");
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF, aborting");
  }

  const error = parsed.searchParams.get("error");
  if (error) {
    const errorDescription = parsed.searchParams.get("error_description") ?? "";
    throw new Error(`OAuth error: ${error}${errorDescription ? ` — ${errorDescription}` : ""}`);
  }

  const code = parsed.searchParams.get("code");
  if (!code) {
    throw new Error("OAuth callback missing authorization code");
  }

  const tokenBody = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (CLIENT_SECRET) {
    tokenBody.set("client_secret", CLIENT_SECRET);
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(`Token exchange failed (${tokenResp.status}): ${errText}`);
  }

  const json = (await tokenResp.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
    refresh_token?: string;
  };

  const token: GoogleToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshToken: json.refresh_token,
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: token });
  log("info", "Google OAuth succeeded, token stored in local storage");
  return token;
}

export async function revokeGoogleAuth(): Promise<void> {
  const existing = await getRawStoredToken();
  // Revoke the refresh token if we have one (cascades to access tokens);
  // otherwise revoke the access token directly.
  const tokenToRevoke = existing?.refreshToken ?? existing?.accessToken;
  if (tokenToRevoke) {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
        { method: "POST" },
      );
    } catch (err) {
      log("warn", "Token revocation request failed (clearing locally anyway):", err);
    }
  }
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Internal: read whatever is in storage without refresh logic.
 * Used by revokeGoogleAuth (which needs the refresh token itself).
 */
async function getRawStoredToken(): Promise<GoogleToken | null> {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const token = res[STORAGE_KEY] as GoogleToken | undefined;
  return token ?? null;
}

/**
 * Return a valid access token, auto-refreshing if expired and a refresh
 * token is available. Returns null if no token exists or refresh fails.
 */
export async function getStoredToken(): Promise<GoogleToken | null> {
  const token = await getRawStoredToken();
  if (!token) return null;

  // Still valid (with 60s safety margin).
  if (Date.now() < token.expiresAt - 60_000) {
    return token;
  }

  // Expired — try to refresh if we have a refresh token.
  if (token.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(token.refreshToken);
      return refreshed;
    } catch (err) {
      log("warn", "Auto-refresh failed, clearing token:", err);
      await chrome.storage.local.remove(STORAGE_KEY);
      return null;
    }
  }

  // No refresh token, access token expired — clear and return null.
  await chrome.storage.local.remove(STORAGE_KEY);
  return null;
}

/**
 * Use the refresh token to get a new access token from Google.
 * Stores the updated token (with the same refresh token) in local storage.
 */
async function refreshAccessToken(
  refreshToken: string,
): Promise<GoogleToken> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (CLIENT_SECRET) {
    body.set("client_secret", CLIENT_SECRET);
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Refresh failed (${resp.status}): ${text}`);
  }

  const json = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  const updated: GoogleToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    refreshToken, // Google doesn't return a new refresh token on refresh
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  log("info", "Access token refreshed successfully");
  return updated;
}

// PKCE helpers live in ./pkce — pure functions, unit-tested under Node.
