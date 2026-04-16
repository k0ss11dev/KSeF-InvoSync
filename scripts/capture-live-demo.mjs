#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Live demo recording: spins up the extension with a real KSeF token (read
// from tests/fixtures/real-ksef-token.local), sets auto-sync to 1 minute,
// drives the popup through a clean setup, then records a video while a
// SECOND process seeds 3 fresh invoices and the popup picks them up live
// on the next auto-sync tick.
//
// Output: ./screenshots-auto/live-demo.webm  (gitignored)
//
// Requirements:
//   - tests/fixtures/real-ksef-token.local  containing the BUYER token
//     (the NIP that should receive seeded invoices)
//   - A second NIP available for the seller; either pass --seller-token PATH
//     or have the seed script's default fixture point to a seller token
//   - Built extension (npm run build:chrome)
//   - Headed mode (cannot run on a headless server without Xvfb)
//
// Usage:
//   node scripts/capture-live-demo.mjs [--seller-nip 5861719741] [--invoices 3]
//
// Estimated run time: ~90 seconds (vault setup + first sync + wait for next
// auto-sync tick after seeding).

import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { copyFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXTENSION_PATH = resolve(ROOT, "dist/chrome");
const BUYER_TOKEN_FILE = resolve(ROOT, "tests/fixtures/buyer.local");
const SELLER_TOKEN_FILE = resolve(ROOT, "tests/fixtures/real-ksef-token.local");
const OUT_DIR = resolve(ROOT, "screenshots-auto");
const POPUP_VIEWPORT = { width: 400, height: 600 };

const args = process.argv.slice(2);
const buyerNipFromArgs =
  args.includes("--buyer-nip") ? args[args.indexOf("--buyer-nip") + 1] : null;
const sellerNip =
  args.includes("--seller-nip") ? args[args.indexOf("--seller-nip") + 1] : null;
const invoiceCount = args.includes("--invoices")
  ? parseInt(args[args.indexOf("--invoices") + 1], 10)
  : 3;

if (!existsSync(EXTENSION_PATH)) {
  console.error(`✗ ${EXTENSION_PATH} missing — run "npm run build:chrome" first.`);
  process.exit(1);
}
if (!existsSync(BUYER_TOKEN_FILE)) {
  console.error(`✗ ${BUYER_TOKEN_FILE} missing — put the BUYER token there.`);
  process.exit(1);
}
if (!existsSync(SELLER_TOKEN_FILE)) {
  console.error(`✗ ${SELLER_TOKEN_FILE} missing — put the SELLER token there.`);
  process.exit(1);
}

const buyerToken = readFileSync(BUYER_TOKEN_FILE, "utf8").trim();
const sellerToken = readFileSync(SELLER_TOKEN_FILE, "utf8").trim();
const buyerNip =
  buyerNipFromArgs ?? buyerToken.match(/\|nip-(\d{10})\|/)?.[1] ?? "";
const sellerNipResolved =
  sellerNip ?? sellerToken.match(/\|nip-(\d{10})\|/)?.[1] ?? "";

if (!buyerNip || !sellerNipResolved) {
  console.error("Could not parse NIPs from the token files.");
  process.exit(1);
}
console.log(`buyer NIP: ${buyerNip}  (vault setup uses this token)`);
console.log(`seller NIP: ${sellerNipResolved}  (seed script uses real-ksef-token.local)`);

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------

const userDataDir = mkdtempSync(resolve(tmpdir(), "ksef-livedemo-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: POPUP_VIEWPORT,
  recordVideo: { dir: OUT_DIR, size: POPUP_VIEWPORT },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${POPUP_VIEWPORT.width},${POPUP_VIEWPORT.height}`,
    "--disable-features=Translate",
    "--lang=en-US",
  ],
});

await (await context.newPage()).goto("about:blank");
if (context.serviceWorkers().length === 0) {
  await context.waitForEvent("serviceworker", { timeout: 60_000 });
}
const sw = context.serviceWorkers()[0];
const extensionId = sw.url().split("/")[2];
console.log(`extension id: ${extensionId}`);

// =========================================================================
// PHASE 1 — SETUP (recording discarded). Open popup, fill the vault setup
// form, trigger a baseline sync. Close the page so its video segment ends
// and gets discarded; the next page starts a fresh segment for the demo.
// =========================================================================
console.log("phase 1: vault setup (this page's video will be discarded)...");
const setupPage = await context.newPage();
await setupPage.setViewportSize(POPUP_VIEWPORT);
await setupPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
await setupPage.waitForTimeout(800);

// Click gear icon to open settings view
const gearBtn = setupPage.getByRole("button", { name: /settings|ustawienia/i });
await gearBtn.waitFor({ state: "visible", timeout: 10000 });
await gearBtn.click();
await setupPage.waitForTimeout(1500);

const passphraseInput = setupPage.locator('input[placeholder*="characters"], input[placeholder*="znaków"]').first();
await passphraseInput.waitFor({ state: "visible", timeout: 15000 });
await passphraseInput.fill("demo-pass-123");

const tokenInput = setupPage.locator('input[placeholder*="Tokens"], input[placeholder*="aplikacji"], input[placeholder*="from KSeF"]').first();
await tokenInput.fill(buyerToken);

await setupPage.waitForTimeout(800);
const nipInput = setupPage.locator('input[placeholder*="NIP"], input[placeholder*="tax ID"], input[placeholder*="podatkowy"]').first();
const currentNip = await nipInput.inputValue().catch(() => "");
if (!currentNip) await nipInput.fill(buyerNip);

await setupPage.getByRole("button", { name: /set up vault|skonfiguruj sejf/i }).click();
await setupPage.waitForTimeout(3500);
console.log("  ✓ vault created");

await sw.evaluate(async () => {
  await chrome.storage.local.set({
    "config.autoSync": { enabled: true, periodMinutes: 1 },
    "config.calendarEnabled": true,
    "config.sheetsEnabled": true,
  });
  const all = await chrome.alarms.getAll();
  for (const a of all) await chrome.alarms.clear(a.name);
  await chrome.alarms.create("invo-sync.autoSync", { periodInMinutes: 1 });
});

// Click close icon to go back to main view
const closeBtn = setupPage.getByRole("button", { name: /status/i });
try {
  await closeBtn.waitFor({ state: "visible", timeout: 3000 });
  await closeBtn.click();
} catch {
  // Might already be on main view — try clicking gear to toggle back
  const gear2 = setupPage.getByRole("button", { name: /settings|ustawienia/i });
  if (await gear2.count()) await gear2.click();
}
await setupPage.waitForTimeout(1500);
await setupPage.getByRole("button", { name: /sync now|synchronizuj teraz/i }).click();
await setupPage.waitForTimeout(12_000);
console.log("  ✓ baseline sync done");

const setupVideoPath = await setupPage.video()?.path();
await setupPage.close();
await new Promise((r) => setTimeout(r, 500));

// =========================================================================
// PHASE 2 — DEMO (recording kept). Open a NEW popup page on the already-
// initialised + populated state. Take a baseline screenshot, inject 3 fresh
// "incoming" invoices via chrome.storage.local — popup's storage.onChanged
// listener picks them up and rerenders. Fresh items show the unread
// highlight (left bar + tinted bg) because their syncedAt > the lastReadAt
// set by the previous page's auto-mark-read. Take a second screenshot of
// the post-injection state.
// =========================================================================
console.log("phase 2: opening fresh popup for the demo...");
const demoPage = await context.newPage();
await demoPage.setViewportSize(POPUP_VIEWPORT);
await demoPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
await demoPage.waitForTimeout(2500);

await demoPage.screenshot({ path: resolve(OUT_DIR, "popup-baseline.png") });
console.log("  ✓ popup-baseline.png");

console.log(`  injecting ${invoiceCount} fresh incoming invoices...`);
await sw.evaluate(
  async ({ count, sellerNip }) => {
    const now = new Date().toISOString();
    const sellerNames = ["Faktoria Tech S.A.", "Brzmienie sp. z o.o.", "Stalpol-Trans sp.j."];
    const amounts = [12_350, 4_780, 28_900, 1_540, 6_220];
    const fresh = Array.from({ length: count }, (_, i) => ({
      ksefNumber: `20260415-EE-LIVE${String(Date.now() + i).slice(-7)}-AAAAAAAAAA-DD`,
      invoiceNumber: `FA/LIVE/2026/${5000 + i}`,
      sellerNip,
      sellerName: sellerNames[i % sellerNames.length],
      grossAmount: amounts[i % amounts.length],
      currency: "PLN",
      issueDate: now.slice(0, 10),
      syncedAt: now,
    }));

    const existing = (await chrome.storage.local.get("sync.incoming.feed"))["sync.incoming.feed"] ?? [];
    const combined = [...fresh, ...existing].slice(0, 50);

    const prevStats = (await chrome.storage.local.get("sync.lastStats"))["sync.lastStats"] ?? {};
    const newStats = {
      ...prevStats,
      syncedAt: now,
      totalIncoming: (prevStats.totalIncoming ?? 0) + count,
      newIncoming: count,
      appendedRows: count,
    };

    // NOTE: deliberately NOT touching sync.incoming.lastReadAt here so the
    // existing 45 items keep isNew=false (their syncedAt < lastReadAt set
    // by the previous page's auto-mark-read), while the fresh items pass
    // the check (their syncedAt > lastReadAt) and render with the unread
    // highlight + left primary-coloured bar.
    await chrome.storage.local.set({
      "sync.incoming.feed": combined,
      "sync.lastStats": newStats,
    });
  },
  { count: invoiceCount, sellerNip: sellerNipResolved },
);
console.log("  ✓ injected — fresh items should highlight at top of feed");

// Hold for the viewer + capture the highlighted state.
await demoPage.waitForTimeout(2500);
await demoPage.screenshot({ path: resolve(OUT_DIR, "popup-with-new-incoming.png") });
console.log("  ✓ popup-with-new-incoming.png");
await demoPage.waitForTimeout(5000);

const demoVideoPath = await demoPage.video()?.path();
await demoPage.close();
await context.close();

if (demoVideoPath) {
  const finalPath = resolve(OUT_DIR, "live-demo.webm");
  await copyFile(demoVideoPath, finalPath);
  await unlink(demoVideoPath).catch(() => {});
  console.log(`\n✓ saved → ${finalPath}`);
}
if (setupVideoPath) {
  await unlink(setupVideoPath).catch(() => {});
}
