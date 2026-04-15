// SPDX-License-Identifier: GPL-3.0-or-later
// M3 sub-turn 3 e2e: true incremental sync / dedup.
//
// runSync() now tracks which KSeF reference numbers it has already written
// to a given spreadsheet (in chrome.storage.local, keyed per spreadsheet id)
// and filters those out of the query result before calling appendRows.
//
// These tests exercise the three meaningful dedup scenarios:
//   1. Re-sync with no new invoices      → 0 rows appended
//   2. Re-sync with exactly one new      → 1 row appended (and it's the right one)
//   3. Switching to a different sheet    → new sheet gets a fresh backfill
//                                          (tracked sets are per-spreadsheet)

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
const GOOGLE_TOKEN = "fake-google-access-token-dedup";

test.describe("M3 sub-turn 3 — dedup / true incremental sync", () => {
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
    // Clean slate: no vault, no stored target, no tracked ksef numbers.
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

  test("re-sync with no new invoices: 0 rows appended on second run", async ({
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

        const first = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        const second = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        const trackedAfter = await cfg.getTrackedKsefNumbers(first.spreadsheetId!);
        return {
          firstAppended: first.appendedRows,
          firstCreated: first.createdSpreadsheet,
          secondAppended: second.appendedRows,
          secondCreated: second.createdSpreadsheet,
          // totalCount stays the same — dedup happens AFTER the query, so
          // the KSeF "how many invoices in this date range" answer doesn't
          // change between runs.
          secondTotalCount: second.totalCount,
          trackedCount: trackedAfter.size,
          // Both runs should target the same spreadsheet.
          sameSheet: first.spreadsheetId === second.spreadsheetId,
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

    expect(result.firstCreated).toBe(true);
    expect(result.firstAppended).toBe(30);

    expect(result.secondCreated).toBe(false);
    expect(result.secondAppended).toBe(0);
    expect(result.secondTotalCount).toBe(30); // query still returns 30
    expect(result.sameSheet).toBe(true);
    expect(result.trackedCount).toBe(30);

    // First sync: 30 outgoing + 10 incoming = 40. Second: 0+0 (all deduped).
    expect(sheetsMock.totalRowsAppended).toBe(40);
    expect(sheetsMock.createdSpreadsheets.size).toBe(1);
  });

  test("re-sync with one new invoice: appends exactly that one", async ({
    serviceWorker,
  }) => {
    // Strategy: sync once, read the tracked set back, manually drop one
    // entry from chrome.storage.local, then sync again. The dedup filter
    // should see the removed ksefNumber as "not yet tracked" and append
    // exactly that single row.
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

        const first = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        const spreadsheetId = first.spreadsheetId!;
        const trackedBefore = await cfg.getTrackedKsefNumbers(spreadsheetId);
        const allNumbers = Array.from(trackedBefore);
        // Drop one ksef number from the tracked set — simulates "one new
        // invoice appeared in KSeF between runs".
        const droppedNumber = allNumbers[allNumbers.length - 1];
        const key = `sync.tracked.${spreadsheetId}`;
        await chrome.storage.local.set({
          [key]: allNumbers.slice(0, -1),
        });

        const second = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });

        const trackedAfter = await cfg.getTrackedKsefNumbers(spreadsheetId);

        return {
          firstAppended: first.appendedRows,
          secondAppended: second.appendedRows,
          droppedNumber,
          trackedAfterHasDropped: trackedAfter.has(droppedNumber),
          trackedAfterSize: trackedAfter.size,
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

    expect(result.firstAppended).toBe(30);
    // Only the one un-tracked invoice comes through on the second sync.
    expect(result.secondAppended).toBe(1);
    // And it's now back in the tracked set — future syncs will skip it.
    expect(result.trackedAfterHasDropped).toBe(true);
    expect(result.trackedAfterSize).toBe(30);

    // Sync 1: 30 outgoing + 10 incoming = 40. Sync 2: 1 outgoing + 0 incoming = 1.
    expect(sheetsMock.totalRowsAppended).toBe(41);
  });

  test("switching target sheet: new sheet gets a full backfill", async ({
    serviceWorker,
  }) => {
    // Tracked sets are keyed per-spreadsheet, so switching the target to
    // a different sheet must not leak the old sheet's history into the
    // new sheet's dedup decision. Sheet A should keep all 30 rows and
    // its tracked set; sheet B should receive a fresh 30-row backfill.
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

        // Sync 1 → creates sheet A, appends 30, tracks 30 on A.
        const first = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
        const sheetAId = first.spreadsheetId!;

        // User picks "Create new" from the popup → clears the target.
        // The tracked set for sheet A is intentionally LEFT IN PLACE —
        // if the user ever switches back, we don't want to re-append
        // rows that are already in sheet A.
        await cfg.clearTargetSpreadsheetId();

        // Sync 2 → no target, creates sheet B, appends 30, tracks 30 on B.
        const second = await sync.runSync({
          apiBaseUrl: ksefUrl,
          sheetsApiBaseUrl: sheetsUrl,
          googleAccessToken: googleToken,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
        const sheetBId = second.spreadsheetId!;

        const trackedOnA = await cfg.getTrackedKsefNumbers(sheetAId);
        const trackedOnB = await cfg.getTrackedKsefNumbers(sheetBId);

        return {
          sheetAId,
          sheetBId,
          firstCreated: first.createdSpreadsheet,
          firstAppended: first.appendedRows,
          secondCreated: second.createdSpreadsheet,
          secondAppended: second.appendedRows,
          trackedOnASize: trackedOnA.size,
          trackedOnBSize: trackedOnB.size,
          // Dedup is keyed by spreadsheetId, so A's numbers must not
          // leak into B's set and vice versa. Every ksef number should
          // appear in exactly ONE of the two tracked sets — but actually
          // both sets should contain the SAME 30 numbers, because both
          // sheets were backfilled from the same KSeF query.
          bothContainSameNumbers:
            trackedOnA.size === trackedOnB.size &&
            Array.from(trackedOnA).every((n) => trackedOnB.has(n)),
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

    expect(result.firstCreated).toBe(true);
    expect(result.firstAppended).toBe(30);
    expect(result.secondCreated).toBe(true);
    expect(result.secondAppended).toBe(30);
    // Two distinct spreadsheets.
    expect(result.sheetAId).not.toBe(result.sheetBId);
    // Both tracked sets are full (30 ksef numbers each), with the same
    // contents — the two sheets are independent dedup domains.
    expect(result.trackedOnASize).toBe(30);
    expect(result.trackedOnBSize).toBe(30);
    expect(result.bothContainSameNumbers).toBe(true);

    // Sheet A: 30 outgoing + 10 incoming = 40. Sheet B: 30 outgoing + 10 incoming
    // = 40 (per-sheet incoming tracking resets for new sheets). Total: 80.
    expect(sheetsMock.createdSpreadsheets.size).toBe(2);
    expect(sheetsMock.totalRowsAppended).toBe(80);
  });
});
