// SPDX-License-Identifier: GPL-3.0-or-later
// Sheet picker tests — SW-level (picker UI moved to options page).
// Tests verify the message handlers still work correctly.

import { expect, test } from "./fixtures/extension";
import { startMockKsefServer, type MockKsefServer } from "../mocks/ksef-server";
import { startMockGoogleSheetsServer, type MockGoogleSheetsServer } from "../mocks/google-sheets-server";

const GOOGLE_ACCESS_TOKEN = "fake-google-access-token-picker";

test.describe("sheet picker via SW messages", () => {
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

  test.beforeEach(async ({ serviceWorker }) => {
    ksefMock.reset();
    sheetsMock.reset();
    sheetsMock.setAcceptedAccessToken(GOOGLE_ACCESS_TOKEN);

    await serviceWorker.evaluate(async ({ sheetsUrl, googleToken }) => {
      (globalThis as unknown as { __sheetsApiBaseUrlOverride: string }).__sheetsApiBaseUrlOverride = sheetsUrl;
      await chrome.storage.local.set({
        "google.token": { accessToken: googleToken, expiresAt: Date.now() + 3600 * 1000 },
      });
      const originalFetch = self.fetch.bind(self);
      (self as unknown as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("oauth2/v3/userinfo")) {
          return new Response(JSON.stringify({ sub: "test", email: "test@example.com", email_verified: true }),
            { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return originalFetch(input, init);
      };
      const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
      await cfg.destroyAll();
    }, { sheetsUrl: sheetsMock.url, googleToken: GOOGLE_ACCESS_TOKEN });
  });

  test("with no target set, getTarget returns null", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
      return cfg.getTargetSpreadsheet();
    });
    expect(result).toBeNull();
  });

  test("setTarget stores and getTarget returns it", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
      await cfg.setTargetSpreadsheet({ id: "test-id-123", name: "My Sheet" });
      return cfg.getTargetSpreadsheet();
    });
    expect(result?.id).toBe("test-id-123");
    expect(result?.name).toBe("My Sheet");
  });

  test("sheets.list returns pre-created spreadsheets", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async ({ sheetsUrl, googleToken }) => {
      const sheets = (globalThis as unknown as { __sheetsForTests: typeof import("../../src/google/sheets") }).__sheetsForTests;
      await sheets.createSpreadsheetFromTemplate({ apiBaseUrl: sheetsUrl, accessToken: googleToken, title: "Sheet A" });
      await sheets.createSpreadsheetFromTemplate({ apiBaseUrl: sheetsUrl, accessToken: googleToken, title: "Sheet B" });
      const drive = (globalThis as unknown as { __driveForTests: typeof import("../../src/google/drive") }).__driveForTests;
      return drive.listAppCreatedSpreadsheets({ accessToken: googleToken, apiBaseUrl: sheetsUrl });
    }, { sheetsUrl: sheetsMock.url, googleToken: GOOGLE_ACCESS_TOKEN });

    expect(result.length).toBe(2);
    expect(result[0].name).toBe("Sheet B"); // newest first
    expect(result[1].name).toBe("Sheet A");
  });

  test("clearTarget removes the target", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
      await cfg.setTargetSpreadsheet({ id: "x", name: "X" });
      await cfg.clearTargetSpreadsheetId();
      return cfg.getTargetSpreadsheet();
    });
    expect(result).toBeNull();
  });
});
