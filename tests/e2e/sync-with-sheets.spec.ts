// SPDX-License-Identifier: GPL-3.0-or-later
// M2 sub-turn 2 e2e: runSync() with the Google Sheets branch wired in.
// Three scenarios:
//   1. First sync with a Google token → creates spreadsheet, appends, stores ID
//   2. Subsequent sync (vault has stored ID) → appends to the existing sheet
//   3. No Google token → skips Sheets entirely, M1 behaviour preserved

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
const GOOGLE_TOKEN = "fake-google-access-token-for-tests";

test.describe("M2 sub-turn 2 — runSync with Google Sheets append", () => {
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
    // Each test starts with no stored target sheet — wipe persistent-config.
    await serviceWorker.evaluate(async () => {
      const cfg = (
        globalThis as unknown as {
          __persistentConfigForTests: typeof import("../../src/storage/persistent-config");
        }
      ).__persistentConfigForTests;
      await cfg.destroyAll();
    });
  });

  test("first sync with Google token: creates spreadsheet, appends 30 rows, stores ID in persistent-config", async ({
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
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        const result = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        // Read back persistent-config to verify the ID was persisted.
        const storedId = await cfg.getTargetSpreadsheetId();

        return { result, storedId };
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

    expect(result.result.totalCount).toBe(30);
    expect(result.result.createdSpreadsheet).toBe(true);
    expect(result.result.spreadsheetId).toMatch(/^mock-ssid-/);
    expect(result.result.spreadsheetUrl).toContain("docs.google.com/spreadsheets");
    expect(result.result.appendedRows).toBe(30);

    // The vault should now have the ID for next time.
    expect(result.storedId).toBe(result.result.spreadsheetId);

    // 30 outgoing + 10 incoming = 40 total rows appended.
    expect(sheetsMock.totalRowsAppended).toBe(40);
    const created = sheetsMock.createdSpreadsheets.get(result.result.spreadsheetId!);
    expect(created).toBeDefined();
    // 1 header row + 30 appended rows
    expect(created!.rows.length).toBe(31);
  });

  test("second sync: appends to the existing sheet, does NOT re-create", async ({
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
        const sheets = (
          globalThis as unknown as {
            __sheetsForTests: typeof import("../../src/google/sheets");
          }
        ).__sheetsForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // Pre-create a spreadsheet directly via the Sheets client + register
        // its ID in persistent-config. This simulates "user has already done
        // one sync earlier and the target sheet is set up."
        const created = await sheets.createSpreadsheetFromTemplate({
          apiBaseUrl: sheetsUrl,
          accessToken: googleToken,
          title: "Pre-existing spreadsheet from earlier sync",
        });
        await cfg.setTargetSpreadsheetId(created.spreadsheetId);

        const result = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        return { result, expectedSpreadsheetId: created.spreadsheetId };
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

    expect(result.result.totalCount).toBe(30);
    // The key assertion: createdSpreadsheet is FALSE on subsequent syncs.
    expect(result.result.createdSpreadsheet).toBe(false);
    // And the spreadsheet ID matches the one already in the vault.
    expect(result.result.spreadsheetId).toBe(result.expectedSpreadsheetId);
    expect(result.result.appendedRows).toBe(30);

    // The mock should have ONE spreadsheet (not two — we didn't re-create).
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
    // 30 outgoing + 10 incoming = 40.
    expect(sheetsMock.totalRowsAppended).toBe(40);
  });

  test("no Google token: skips Sheets branch entirely (M1 behaviour preserved)", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ ksefUrl, passphrase, ksefToken, nip }) => {
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
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // Note: NO googleAccessToken — runSync should skip the Sheets branch.
        const result = await sync.runSync({
          apiBaseUrl: ksefUrl,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        const storedId = await cfg.getTargetSpreadsheetId();
        return { result, storedId };
      },
      {
        ksefUrl: ksefMock.url,
        passphrase: PASSPHRASE,
        ksefToken: KSEF_TOKEN,
        nip: CONTEXT_NIP,
      },
    );

    // M1 behaviour: count is right, no Sheets fields populated.
    expect(result.result.totalCount).toBe(30);
    expect(result.result.spreadsheetId).toBeUndefined();
    expect(result.result.spreadsheetUrl).toBeUndefined();
    expect(result.result.appendedRows).toBeUndefined();
    expect(result.result.createdSpreadsheet).toBeUndefined();

    // Persistent config was never asked to store an ID.
    expect(result.storedId).toBeNull();

    // Sheets mock was never touched.
    expect(sheetsMock.totalRowsAppended).toBe(0);
    expect(sheetsMock.createdSpreadsheets.size).toBe(0);
  });

  // --- M3 sub-turn 1 regression: vault rebuild must NOT wipe target sheet ---

  test("M3 sub-turn 1: targetSpreadsheetId survives a vault.create() rebuild", async ({
    serviceWorker,
  }) => {
    // The bug: in M2 the targetSpreadsheetId lived inside the encrypted vault
    // and got wiped on every `vault.create()`. This test reproduces the
    // scenario that triggered "new file each sync" against real KSeF and
    // proves the fix works.
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
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        // First setup + sync — creates a fresh spreadsheet
        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        const firstSync = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        // Now rebuild the vault — exactly what happens when the user
        // re-runs the popup setup form (e.g., to change the KSeF token).
        // The SW handler for vault.create calls vault.destroy() first, so
        // we mirror that here.
        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // The persistent-config target ID should STILL be there
        const storedAfterRebuild = await cfg.getTargetSpreadsheetId();

        // Run sync again
        const secondSync = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        return {
          firstSpreadsheetId: firstSync.spreadsheetId,
          firstCreated: firstSync.createdSpreadsheet,
          storedAfterRebuild,
          secondSpreadsheetId: secondSync.spreadsheetId,
          secondCreated: secondSync.createdSpreadsheet,
        };
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

    // First sync created a fresh sheet.
    expect(result.firstCreated).toBe(true);
    expect(result.firstSpreadsheetId).toMatch(/^mock-ssid-/);

    // After vault rebuild, persistent-config still has the same ID.
    expect(result.storedAfterRebuild).toBe(result.firstSpreadsheetId);

    // Second sync used the same sheet — DID NOT create a new one.
    expect(result.secondCreated).toBe(false);
    expect(result.secondSpreadsheetId).toBe(result.firstSpreadsheetId);

    // Mock confirms only ONE spreadsheet ever existed (not two).
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
    // First sync: 30 outgoing + 10 incoming = 40. Second: 0+0 (dedup).
    expect(sheetsMock.totalRowsAppended).toBe(40);
  });

  test("M3 sub-turn 1: persistent-config.destroyAll() forgets the target sheet (for 'reset' UX)", async ({
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
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // First sync stores a target sheet ID in persistent-config
        await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
        const before = await cfg.getTargetSpreadsheetId();

        // Forget all settings
        await cfg.destroyAll();
        const after = await cfg.getTargetSpreadsheetId();

        // Next sync should create a new sheet
        const second = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        return {
          before,
          after,
          secondCreated: second.createdSpreadsheet,
          secondSpreadsheetId: second.spreadsheetId,
        };
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

    expect(result.before).toMatch(/^mock-ssid-/);
    expect(result.after).toBeNull();
    expect(result.secondCreated).toBe(true);
    expect(result.secondSpreadsheetId).not.toBe(result.before);
  });
});
