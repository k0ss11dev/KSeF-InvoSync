// SPDX-License-Identifier: GPL-3.0-or-later
// Build-time defines injected by scripts/build.mjs via esbuild's `define`.
// Values come from .env → GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
// If empty at build time, the extension will throw a helpful error on first
// OAuth attempt rather than silently failing.

declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_CLIENT_SECRET__: string;
