// SPDX-License-Identifier: GPL-3.0-or-later
// Incoming invoices (Subject2 query) — tests that runSync detects buyer-side
// invoices, dedup-tracks them separately from outgoing, and returns counts.

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
const GOOGLE_TOKEN = "fake-google-access-token-incoming";

test.describe("Incoming invoices (Subject2)", () => {
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
    });
  });

  test("first sync returns incomingTotal=10 and newIncomingCount=10", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ ksefUrl, sheetsUrl, passphrase, ksefToken, nip, googleToken }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        return sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
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

    // Outgoing (Subject1) — the usual 30 invoices.
    expect(result.totalCount).toBe(30);
    expect(result.appendedRows).toBe(30);

    // Incoming (Subject2) — 10 mock invoices, all new on first sync.
    expect(result.incomingTotal).toBe(10);
    expect(result.newIncomingCount).toBe(10);

    // Verify the mock: outgoing tab has 31 rows (1 header + 30 data),
    // incoming tab has 11 rows (1 header + 10 data).
    const ssid = result.spreadsheetId!;
    const ss = sheetsMock.createdSpreadsheets.get(ssid)!;
    expect(ss).toBeDefined();
    // Primary tab (Invoices): header + 30 outgoing rows
    expect(ss.rows.length).toBe(31);
    // Incoming tab: header + 10 incoming rows
    const incomingTab = ss.tabs.get("Incoming");
    expect(incomingTab).toBeDefined();
    expect(incomingTab!.rows.length).toBe(11);
  });

  test("second sync: incoming dedup → newIncomingCount=0", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ ksefUrl, sheetsUrl, passphrase, ksefToken, nip, googleToken }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // First sync — seeds the incoming tracked set.
        await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        // Second sync — same invoices, dedup should give 0 new.
        return sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
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

    expect(result.incomingTotal).toBe(10);
    expect(result.newIncomingCount).toBe(0);
  });

  test("incoming tracking is independent of outgoing (sheet) tracking", async ({
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

        await v.create(passphrase);
        await v.setKsefToken(ksefToken);
        await v.setContextNip(nip);

        // First sync: seeds both outgoing + incoming tracked sets.
        const first = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        // Clear the outgoing target → next sync creates a new sheet
        // (re-writes all 30 outgoing rows). Incoming set should be UNTOUCHED.
        await cfg.clearTargetSpreadsheetId();

        const second = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        return {
          firstOutgoing: first.appendedRows,
          firstIncomingNew: first.newIncomingCount,
          // After clearing sheet target, outgoing re-backfills on new sheet
          // but incoming is still 0 because the incoming set wasn't cleared.
          secondOutgoing: second.appendedRows,
          secondIncomingNew: second.newIncomingCount,
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

    expect(result.firstOutgoing).toBe(30);
    expect(result.firstIncomingNew).toBe(10);
    // Outgoing re-backfills (new sheet), but incoming stays deduped.
    expect(result.secondOutgoing).toBe(30);
    expect(result.secondIncomingNew).toBe(0);
  });
});
