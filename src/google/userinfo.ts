// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal wrapper around Google's OpenID userinfo endpoint.
// Used by the service worker to derive the "Connected as ..." string
// shown in the popup, and to verify a cached token is still valid.

import { log } from "../shared/logger";

export type UserInfo = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  log("info", "Userinfo: fetching Google profile");
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    log("warn", `Userinfo: failed ${res.status} — ${text}`);
    throw new Error(`userinfo failed (${res.status}): ${text}`);
  }

  const info = (await res.json()) as UserInfo;
  log("info", `Userinfo: fetched profile for ${info.email}`);
  return info;
}
