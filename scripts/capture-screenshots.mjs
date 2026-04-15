#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Capture popup screenshots + an optional walkthrough video for the Chrome
// Web Store listing. Outputs to ./screenshots-auto/ (gitignored).
//
// What it produces (each PNG is the popup at its native ~400×620 size,
// no surrounding browser chrome):
//   popup-status-light.png
//   popup-status-dark.png
//   popup-config-light.png
//   popup-config-dark.png
//   popup-invoice-modal.png
//   options-page.png
//   walkthrough.webm   (only when --video is passed)
//
// Pre-seeds chrome.storage.local with mock state (vault unlocked, Google
// "connected" flag, sample incoming feed, calendar feature on) so the popup
// renders in a populated state without needing live OAuth or KSeF access.
//
// Usage:
//   npm run build:chrome
//   node scripts/capture-screenshots.mjs              # screenshots only
//   node scripts/capture-screenshots.mjs --video      # screenshots + 20s walkthrough
//
// Requirements: a built dist/chrome/, the project's @playwright/test devdep
// (already installed), and a desktop session with X / a screen (or Xvfb on
// Linux Docker). MV3 extensions can't run in headless mode.

import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXTENSION_PATH = resolve(ROOT, "dist/chrome");
const OUT_DIR = resolve(ROOT, "screenshots-auto");
const POPUP_VIEWPORT = { width: 400, height: 620 };
const RECORD_VIDEO = process.argv.includes("--video");

if (!existsSync(EXTENSION_PATH)) {
  console.error(`✗ ${EXTENSION_PATH} missing — run "npm run build:chrome" first.`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------

const userDataDir = mkdtempSync(resolve(tmpdir(), "ksef-capture-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: POPUP_VIEWPORT,
  ...(RECORD_VIDEO
    ? { recordVideo: { dir: OUT_DIR, size: POPUP_VIEWPORT } }
    : {}),
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${POPUP_VIEWPORT.width},${POPUP_VIEWPORT.height}`,
    // Suppress Chrome's "translate this page" infobar — the popup contains
    // Polish strings which Chrome auto-detects as foreign and offers to
    // translate. The infobar would intrude on screenshots.
    "--disable-features=Translate",
    "--lang=en-US",
  ],
});

// Wait for the SW to register (cold-start can be slow on Windows).
await (await context.newPage()).goto("about:blank");
if (context.serviceWorkers().length === 0) {
  await context.waitForEvent("serviceworker", { timeout: 60_000 });
}
const sw = context.serviceWorkers()[0];
const extensionId = sw.url().split("/")[2];
console.log(`  extension id: ${extensionId}`);

// ---------------------------------------------------------------------------
// Pre-seed chrome.storage.local with mock state so the popup looks "lived in"
// without running real OAuth / KSeF auth.

// Create + unlock a real vault via the SW message handler so isInitialized()
// returns true and the popup proceeds past the "go to Config" gate.
await sw.evaluate(async () => {
  const send = (msg) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(msg, (res) => resolve(res)),
    );
  // Reset first in case a prior run left storage around.
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  // Create vault — this leaves it unlocked (in-memory key set on the SW).
  await send({
    type: "vault.create",
    passphrase: "demo-screenshot-passphrase",
    ksefToken: "20260101-EC-XXXXXXXXXX-XXXXXXXXXX-XX|nip-8698281999|deadbeefcafebabe0011223344556677889900aabbccddeeff0011223344556",
    contextNip: "8698281999",
  });
});

await sw.evaluate(async () => {
  const now = new Date().toISOString();
  const sampleSeller = ["Test Buyer A Sp. z o.o.", "ACME Polska sp. z o.o.", "Faktoria Tech S.A."];
  const sampleNip = ["8698281999", "5861719741", "1234567890"];
  const incoming = Array.from({ length: 5 }, (_, i) => ({
    ksefNumber: `20260414-EE-DEMO${String(i).padStart(7, "0")}-AAAAAAAAAA-00`,
    invoiceNumber: `FA/DEMO/2026/${1000 + i}`,
    sellerNip: sampleNip[i % sampleNip.length],
    sellerName: sampleSeller[i % sampleSeller.length],
    grossAmount: [4500, 12300, 760, 2890, 18900][i],
    currency: "PLN",
    issueDate: "2026-04-14",
    syncedAt: now,
  }));

  await chrome.storage.local.set({
    "config.theme": "light",
    "config.fetchOnResume": true,
    "config.calendarEnabled": true,
    "config.sheetsEnabled": true,
    "config.sheetsSyncOutgoing": true,
    "config.sheetsSyncIncoming": true,
    "config.targetCalendarId": "primary",
    "config.targetSheet": { id: "demo-sheet-id", name: "KSeF invoices — demo" },
    "config.targetSheetUrl": "https://docs.google.com/spreadsheets/d/demo-sheet-id/edit",
    "sync.lastStats": {
      syncedAt: now,
      totalOutgoing: 12,
      totalIncoming: 18,
      appendedRows: 0,
      newIncoming: 2,
    },
    "sync.incoming.feed": incoming,
    "sync.incoming.lastReadAt": new Date(Date.now() - 60_000).toISOString(),
  });
});
console.log("  ✓ seeded mock storage");

// ---------------------------------------------------------------------------

async function openPopup(theme = "light") {
  const popup = await context.newPage();
  await popup.setViewportSize(POPUP_VIEWPORT);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  // Apply theme by setting attribute + class so MUI + CSS pick it up.
  await popup.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.classList.toggle("light", t === "light");
  }, theme);
  await popup.waitForTimeout(500); // let React rerender
  return popup;
}

async function shoot(page, name) {
  const out = resolve(OUT_DIR, name);
  await page.screenshot({ path: out, omitBackground: false });
  console.log(`  ✓ ${name}`);
}

// 1. Status tab — light + dark
for (const theme of ["light", "dark"]) {
  const popup = await openPopup(theme);
  await shoot(popup, `popup-status-${theme}.png`);
  await popup.close();
}

// 2. Config tab — light + dark
for (const theme of ["light", "dark"]) {
  const popup = await openPopup(theme);
  // Click the Config tab
  await popup.getByRole("tab", { name: /config|konfiguracja/i }).click();
  await popup.waitForTimeout(400);
  await shoot(popup, `popup-config-${theme}.png`);
  await popup.close();
}

// 3. Invoice viewer modal (light)
{
  const popup = await openPopup("light");
  // Wait for the feed to render (refresh() is async on mount)
  const firstItem = popup.locator(".MuiListItemButton-root").first();
  try {
    await firstItem.waitFor({ state: "visible", timeout: 5000 });
    await firstItem.click();
    await popup.waitForTimeout(1200);
    await shoot(popup, "popup-invoice-modal.png");
  } catch {
    console.log("  ⚠ no feed item to open for invoice modal — skipped");
  }
  await popup.close();
}

// 4. Options page (light, full content visible)
{
  const opts = await context.newPage();
  await opts.setViewportSize({ width: 800, height: 1100 });
  await opts.goto(`chrome-extension://${extensionId}/options/index.html`);
  await opts.waitForTimeout(800);
  await shoot(opts, "options-page.png");
  await opts.close();
}

// 5. Optional walkthrough video — driven popup tour.
if (RECORD_VIDEO) {
  console.log("  recording walkthrough...");
  const popup = await openPopup("light");
  await popup.waitForTimeout(1000);
  // Click Config tab
  await popup.getByRole("tab", { name: /config|konfiguracja/i }).click();
  await popup.waitForTimeout(2000);
  // Back to Status
  await popup.getByRole("tab", { name: /status/i }).click();
  await popup.waitForTimeout(1500);
  // Open invoice
  const item = popup.locator(".MuiListItemButton-root").first();
  if (await item.count()) {
    await item.click();
    await popup.waitForTimeout(3000);
    // Close modal (Escape)
    await popup.keyboard.press("Escape");
    await popup.waitForTimeout(800);
  }
  // Toggle dark mode
  await popup
    .getByRole("button", { name: /dark mode|light mode/i })
    .click()
    .catch(() => {});
  await popup.waitForTimeout(1500);
  await popup.close();
  // Save the video file with a stable name
  const video = popup.video();
  if (video) {
    const tmpPath = await video.path();
    const finalPath = resolve(OUT_DIR, "walkthrough.webm");
    const { copyFile, unlink } = await import("node:fs/promises");
    await copyFile(tmpPath, finalPath);
    await unlink(tmpPath).catch(() => {});
    console.log(`  ✓ walkthrough.webm`);
  }
}

await context.close();
console.log(`\n✓ Done. Output → ${OUT_DIR}`);
