// SPDX-License-Identifier: GPL-3.0-or-later
// Re-exports of Web Crypto types for places that import them as type-only
// (to keep imports explicit). The runtime values come from globalThis in
// both the browser (extension service worker) and Node 20+.

export type { CryptoKey };
