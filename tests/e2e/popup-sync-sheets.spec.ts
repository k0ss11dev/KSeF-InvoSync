// SPDX-License-Identifier: GPL-3.0-or-later
// Popup sync+sheets tests — adapted for tabbed layout.
// Vault setup is done via SW bridge; popup tests the sync UI.

import { expect, test } from "./fixtures/extension";
import { startMockKsefServer, type MockKsefServer } from "../mocks/ksef-server";
import { startMockGoogleSheetsServer, type MockGoogleSheetsServer } from "../mocks/google-sheets-server";

const PASSPHRASE = "correct horse battery staple";
const KSEF_TOKEN = "fake-ksef-test-token-AAAA-BBBB";
const CONTEXT_NIP = "5555555555";
const GOOGLE_ACCESS_TOKEN = "fake-google-access-token-popup-sync";
const FAKE_EMAIL = "test@example.com";

test.describe("popup Sheets sync", () => {
  let ksefMock: MockKsefServer;
  let sheetsMock: MockGoogleSheetsServer;

  test.beforeAll(async () => {
    ksefMock = await startMockKsefServer();
    sheetsMock = await startMockGoogleSheetsServer();
  });
  test.afterAll(async () => {
    await ksefMock?.close();
    await sheetsMock?.close();
  });

  // Helper: configure SW with mocks + vault + google token
  async function setupSW(serviceWorker: import("@playwright/test").Worker, opts: { google: boolean }) {
    ksefMock.reset();
    sheetsMock.reset();
    sheetsMock.setAcceptedAccessToken(GOOGLE_ACCESS_TOKEN);

    await serviceWorker.evaluate(
      async ({ ksefUrl, sheetsUrl, googleToken, fakeEmail, passphrase, ksefToken, nip, connectGoogle }) => {
        (globalThis as unknown as { __ksefApiBaseUrlOverride: string }).__ksefApiBaseUrlOverride = ksefUrl;
        (globalThis as unknown as { __sheetsApiBaseUrlOverride: string }).__sheetsApiBaseUrlOverride = sheetsUrl;

        if (connectGoogle) {
          await chrome.storage.local.set({
            "google.token": { accessToken: googleToken, expiresAt: Date.now() + 3600 * 1000 },
          });
          const originalFetch = self.fetch.bind(self);
          (self as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes("oauth2/v3/userinfo")) {
              return new Response(JSON.stringify({ sub: "test", email: fakeEmail, email_verified: true }),
                { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return originalFetch(input, init);
          };
        }

        const v = (globalThis as unknown as { __vaultForTests: typeof import("../../src/storage/vault") }).__vaultForTests;
        const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
        await v.destroy();
        await cfg.destroyAll();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);
      },
      {
        ksefUrl: ksefMock.url, sheetsUrl: sheetsMock.url,
        googleToken: GOOGLE_ACCESS_TOKEN, fakeEmail: FAKE_EMAIL,
        passphrase: PASSPHRASE, ksefToken: KSEF_TOKEN, nip: CONTEXT_NIP,
        connectGoogle: opts.google,
      },
    );
  }

  test("sync without Google: shows sync result", async ({ context, extensionId, serviceWorker }) => {
    await setupSW(serviceWorker, { google: false });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(page.getByText(/synced.*30.*invoices/i)).toBeVisible({ timeout: 10_000 });
  });

  test("first sync with Google: shows sync result + sheet rows appended", async ({ context, extensionId, serviceWorker }) => {
    await setupSW(serviceWorker, { google: true });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(page.getByText(/synced.*30.*invoices/i)).toBeVisible({ timeout: 10_000 });
    // 30 outgoing + 10 incoming = 40 total rows appended
    expect(sheetsMock.totalRowsAppended).toBe(40);
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
  });

  test("subsequent sync: appends to existing sheet", async ({ context, extensionId, serviceWorker }) => {
    await setupSW(serviceWorker, { google: true });
    // Pre-create a sheet
    await serviceWorker.evaluate(
      async ({ sheetsUrl, googleToken }) => {
        const sheets = (globalThis as unknown as { __sheetsForTests: typeof import("../../src/google/sheets") }).__sheetsForTests;
        const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
        const created = await sheets.createSpreadsheetFromTemplate({ apiBaseUrl: sheetsUrl, accessToken: googleToken, title: "Pre-existing" });
        await cfg.setTargetSpreadsheetId(created.spreadsheetId);
      },
      { sheetsUrl: sheetsMock.url, googleToken: GOOGLE_ACCESS_TOKEN },
    );

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(page.getByText(/synced.*30.*invoices/i)).toBeVisible({ timeout: 10_000 });
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
    // 30 outgoing + 10 incoming = 40
    expect(sheetsMock.totalRowsAppended).toBe(40);
  });
});
