// SPDX-License-Identifier: GPL-3.0-or-later
// M3 sub-turn 4 e2e: auto-sync toggle + chrome.alarms wiring.
//
// Tests exercise the config persistence, the alarm lifecycle, the
// background sync gate (vault locked / no google token / happy path),
// and the popup toggle UI.

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";
import {
  startMockGoogleSheetsServer,
  type MockGoogleSheetsServer,
} from "../mocks/google-sheets-server";

const PASSPHRASE = "correct horse battery staple";
const KSEF_TOKEN = "fake-ksef-test-token-AAAA-BBBB";
const CONTEXT_NIP = "5555555555";
const GOOGLE_TOKEN = "fake-google-access-token-autosync";
const FAKE_EMAIL = "autosync@example.com";
const ALARM_NAME = "invo-sync.autoSync";

test.describe("M3 sub-turn 4 — auto-sync", () => {
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
    sheetsMock.setAcceptedAccessToken(GOOGLE_TOKEN);
    await serviceWorker.evaluate(async () => {
      const v = (
        globalThis as unknown as {
          __vaultForTests: typeof import("../../src/storage/vault");
        }
      ).__vaultForTests;
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;
      await v.destroy();
      await cfg.destroyAll();
      // Clear any leftover alarm from previous test
      await chrome.alarms.clearAll();
    });
  });

  test("default: auto-sync is OFF, no alarm registered", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;
      const enabled = await cfg.getAutoSyncEnabled();
      const alarm = await chrome.alarms.get("invo-sync.autoSync");
      return { enabled, hasAlarm: !!alarm };
    });
    expect(result.enabled).toBe(false);
    expect(result.hasAlarm).toBe(false);
  });

  test("enable auto-sync → alarm is created; disable → alarm is cleared", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;
      const autoSync = (
        globalThis as unknown as {
          __autoSyncForTests: typeof import("../../src/background/auto-sync");
        }
      ).__autoSyncForTests;

      // Enable
      await cfg.setAutoSyncEnabled(true);
      await autoSync.ensureAlarmMatchesConfig();
      const alarmAfterEnable = await chrome.alarms.get(
        "invo-sync.autoSync",
      );

      // Disable
      await cfg.setAutoSyncEnabled(false);
      await autoSync.ensureAlarmMatchesConfig();
      const alarmAfterDisable = await chrome.alarms.get(
        "invo-sync.autoSync",
      );

      return {
        enabledAlarmExists: !!alarmAfterEnable,
        enabledPeriod: alarmAfterEnable?.periodInMinutes,
        disabledAlarmExists: !!alarmAfterDisable,
      };
    });
    expect(result.enabledAlarmExists).toBe(true);
    expect(result.enabledPeriod).toBe(30);
    expect(result.disabledAlarmExists).toBe(false);
  });

  test("runBackgroundSyncIfReady skips when vault is locked", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;
      const autoSync = (
        globalThis as unknown as {
          __autoSyncForTests: typeof import("../../src/background/auto-sync");
        }
      ).__autoSyncForTests;
      // Enable but don't unlock vault
      await cfg.setAutoSyncEnabled(true);
      return autoSync.runBackgroundSyncIfReady();
    });
    expect(result.ran).toBe(false);
    expect((result as { reason: string }).reason).toBe("vault-locked");
  });

  test("runBackgroundSyncIfReady skips when no Google token", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ passphrase, ksefToken, nip }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const cfg = (
          globalThis as unknown as {
            __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
          }
        ).__persistentConfigForTests;
        const autoSync = (
          globalThis as unknown as {
            __autoSyncForTests: typeof import("../../src/background/auto-sync");
          }
        ).__autoSyncForTests;

        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);
        await cfg.setAutoSyncEnabled(true);
        // NO google token in storage
        return autoSync.runBackgroundSyncIfReady();
      },
      { passphrase: PASSPHRASE, ksefToken: KSEF_TOKEN, nip: CONTEXT_NIP },
    );
    expect(result.ran).toBe(false);
    expect((result as { reason: string }).reason).toBe("no-google-token");
  });

  test("runBackgroundSyncIfReady runs full sync when vault unlocked + Google connected", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ ksefUrl, sheetsUrl, passphrase, ksefToken, nip, googleToken }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const cfg = (
          globalThis as unknown as {
            __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
          }
        ).__persistentConfigForTests;
        const autoSync = (
          globalThis as unknown as {
            __autoSyncForTests: typeof import("../../src/background/auto-sync");
          }
        ).__autoSyncForTests;

        (
          globalThis as unknown as { __ksefApiBaseUrlOverride: string }
        ).__ksefApiBaseUrlOverride = ksefUrl;
        (
          globalThis as unknown as { __sheetsApiBaseUrlOverride: string }
        ).__sheetsApiBaseUrlOverride = sheetsUrl;

        await chrome.storage.local.set({
          "google.token": {
            accessToken: googleToken,
            expiresAt: Date.now() + 3600 * 1000,
          },
        });

        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);
        await cfg.setAutoSyncEnabled(true);
        return autoSync.runBackgroundSyncIfReady();
      },
      {
        ksefUrl: ksefMock.url,
        sheetsUrl: sheetsMock.url,
        passphrase: PASSPHRASE,
        ksefToken: KSEF_TOKEN,
        nip: CONTEXT_NIP,
        googleToken: GOOGLE_TOKEN,
      },
    );
    expect(result.ran).toBe(true);
    expect((result as { totalCount: number }).totalCount).toBe(30);
    expect((result as { appendedRows: number }).appendedRows).toBe(30);

    // Sheet was auto-created by the background sync.
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
    // 30 outgoing + 10 incoming = 40 total
    expect(sheetsMock.totalRowsAppended).toBe(40);
  });

  test("popup interval select: choosing a value enables auto-sync + creates alarm", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    // Set up vault via SW bridge so Status tab is active
    await serviceWorker.evaluate(
      async ({ ksefUrl, passphrase, ksefToken, nip }) => {
        (globalThis as unknown as { __ksefApiBaseUrlOverride: string }).__ksefApiBaseUrlOverride = ksefUrl;
        const v = (globalThis as unknown as { __vaultForTests: typeof import("../../src/storage/vault") }).__vaultForTests;
        const cfg = (globalThis as unknown as { __persistentConfigForTests: typeof import("../../src/storage/persistent-config") }).__persistentConfigForTests;
        await v.destroy();
        await cfg.destroyAll();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);
      },
      { ksefUrl: ksefMock.url, passphrase: PASSPHRASE, ksefToken: KSEF_TOKEN, nip: CONTEXT_NIP },
    );

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);

    // The interval select should be visible on the Status tab
    const select = page.locator(".interval-select");
    await expect(select).toBeVisible();

    // Select 60 min → enables auto-sync
    await select.selectOption("60");
    // Wait for the async IPC to complete
    await page.waitForTimeout(1000);

    // Verify alarm was created
    const afterOn = await serviceWorker.evaluate(async () => {
      const alarm = await chrome.alarms.get("invo-sync.autoSync");
      return { exists: !!alarm, period: alarm?.periodInMinutes };
    });
    expect(afterOn.exists).toBe(true);
    expect(afterOn.period).toBe(60);

    // Select "off" → disables
    await select.selectOption("off");
    const afterOff = await serviceWorker.evaluate(async () => {
      const alarm = await chrome.alarms.get("invo-sync.autoSync");
      return { exists: !!alarm };
    });
    expect(afterOff.exists).toBe(false);
  });

  test("destroyAll clears auto-sync config", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async () => {
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;

      await cfg.setAutoSyncEnabled(true);
      const before = await cfg.getAutoSyncEnabled();
      await cfg.destroyAll();
      const after = await cfg.getAutoSyncEnabled();
      return { before, after };
    });
    expect(result.before).toBe(true);
    expect(result.after).toBe(false);
  });
});
