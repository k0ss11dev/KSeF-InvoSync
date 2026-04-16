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
// Phase 1: set up vault via the popup UI (SW can't message itself, so we
// drive the actual form). Then seed mock data into storage.
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "20260101-EC-XXXXXXXXXX-XXXXXXXXXX-XX|nip-8698281999|deadbeefcafebabe0011223344556677889900aabbccddeeff0011223344556677";

console.log("  setting up vault via popup UI...");
const setupPage = await context.newPage();
await setupPage.setViewportSize(POPUP_VIEWPORT);
await setupPage.goto(`chrome-extension://${extensionId}/popup/index.html`);
await setupPage.waitForTimeout(1000);

// Click gear to open settings view
const gearBtn = setupPage.getByRole("button", { name: /settings|ustawienia/i });
await gearBtn.waitFor({ state: "visible", timeout: 10000 });
await gearBtn.click();
await setupPage.waitForTimeout(1000);

// Fill vault form
const passInput = setupPage.locator('input[placeholder*="characters"], input[placeholder*="znaków"]').first();
await passInput.waitFor({ state: "visible", timeout: 10000 });
await passInput.fill("demo-screenshot-pass");

const tokenInput = setupPage.locator('input[placeholder*="Tokens"], input[placeholder*="aplikacji"], input[placeholder*="from KSeF"]').first();
await tokenInput.fill(FAKE_TOKEN);

await setupPage.waitForTimeout(500);
const nipInput = setupPage.locator('input[placeholder*="NIP"], input[placeholder*="tax ID"], input[placeholder*="podatkowy"]').first();
const nipVal = await nipInput.inputValue().catch(() => "");
if (!nipVal) await nipInput.fill("8698281999");

await setupPage.getByRole("button", { name: /set up vault|skonfiguruj sejf/i }).click();
await setupPage.waitForTimeout(3000);
console.log("  ✓ vault created");
await setupPage.close();

// Seed mock data (vault is now unlocked in SW memory)
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

// 2. Settings view — light + dark (click gear icon to toggle)
for (const theme of ["light", "dark"]) {
  const popup = await openPopup(theme);
  // Click the settings gear icon in the header
  const settingsBtn = popup.getByRole("button", { name: /settings|ustawienia/i });
  await settingsBtn.waitFor({ state: "visible", timeout: 5000 });
  await settingsBtn.click();
  await popup.waitForTimeout(600);
  await shoot(popup, `popup-config-${theme}.png`);
  await popup.close();
}

// 3. Invoice viewer modal (light) — mock the KSeF XML fetch so the modal
//    renders a real-looking invoice instead of an auth error.
{
  const MOCK_FA3_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza></Naglowek>
  <Podmiot1><DaneIdentyfikacyjne><NIP>5861719741</NIP><Nazwa>Test Seller Sp. z o.o.</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Marszałkowska 12, 00-001 Warszawa</AdresL1></Adres></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>8698281999</NIP><Nazwa>Test Buyer A Sp. z o.o.</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Krakowskie Przedmieście 5, 00-068 Warszawa</AdresL1></Adres></Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-04-14</P_1>
    <P_1M>Warszawa</P_1M>
    <P_2>FA/DEMO/2026/1000</P_2>
    <P_6>2026-04-14</P_6>
    <P_13_1>4500.00</P_13_1>
    <P_14_1>1035.00</P_14_1>
    <P_15>5535.00</P_15>
    <Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie></Adnotacje>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Konsultacja wdrożeniowa KSeF</P_7><P_8A>godz.</P_8A><P_8B>5</P_8B><P_9A>500.00</P_9A><P_11>2500.00</P_11><P_12>23</P_12></FaWiersz>
    <FaWiersz><NrWierszaFa>2</NrWierszaFa><P_7>Szkolenie z e-fakturowania (1 dzień)</P_7><P_8A>szt.</P_8A><P_8B>2</P_8B><P_9A>1000.00</P_9A><P_11>2000.00</P_11><P_12>23</P_12></FaWiersz>
    <Platnosc><TerminPlatnosci><Termin>2026-04-28</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci></Platnosc>
  </Fa>
</Faktura>`;

  const popup = await openPopup("light");

  // Monkey-patch chrome.runtime.sendMessage in the POPUP to intercept the
  // invoice.fetchXml message and return mock XML — avoids the real KSeF
  // auth flow which fails with a fake token.
  await popup.evaluate((mockXml) => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, callback) => {
      if (msg && msg.type === "invoice.fetchXml") {
        if (callback) callback({ ok: true, data: mockXml });
        return;
      }
      return orig(msg, callback);
    };
  }, MOCK_FA3_XML);

  const firstItem = popup.locator(".MuiListItemButton-root").first();
  try {
    await firstItem.waitFor({ state: "visible", timeout: 5000 });
    await firstItem.click();
    await popup.waitForTimeout(1500);
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
