// SPDX-License-Identifier: GPL-3.0-or-later
// Pure PKCE (RFC 7636) helpers — no browser-specific APIs beyond what
// Node 20+ also exposes on globalThis (crypto.getRandomValues, crypto.subtle,
// btoa, TextEncoder). Split from auth.ts so they can be unit-tested under
// Node / Playwright's test runner without loading a full browser context.

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(new Uint8Array(hash));
}

export function base64url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
