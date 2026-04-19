// SPDX-License-Identifier: GPL-3.0-or-later
// Finding #6: destroyAll() used to remove only 8 of the 19 config keys,
// leaving behind actual business data (last 50 incoming invoices, calendar
// event IDs, etc.). Verify that after destroyAll() + the module's own
// tracked-key cleanup, chrome.storage.local is empty.

import { expect, test } from "./fixtures/extension";

type PcBridge = {
  destroyAll(): Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __persistentConfigForTests: PcBridge | undefined;
}

// Every key name that persistent-config.ts owns as of 0.1.2. If this list
// goes out of sync with ALL_CONFIG_KEYS in the source file, destroyAll will
// leak data — both the code array and this test list need updating.
const ALL_KEYS = [
  "config.targetSpreadsheetId",
  "config.targetSpreadsheetName",
  "config.autoSyncEnabled",
  "config.autoSyncIntervalMin",
  "config.targetSheetUrl",
  "config.notifications",
  "sync.incoming.tracked",
  "sync.incoming.feed",
  "sync.incoming.lastReadAt",
  "config.ksefEnvironment",
  "sync.lastStats",
  "config.rememberVault",
  "config.targetCalendarId",
  "config.fetchOnResume",
  "config.calendarEnabled",
  "config.invoiceCalendarEvents",
  "config.sheetsEnabled",
  "config.sheetsSyncOutgoing",
  "config.sheetsSyncIncoming",
];

test.describe("persistent-config destroyAll", () => {
  test("removes every static key this module owns + dynamic sync.tracked.* entries", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async (keys) => {
      // Wipe first so we start from a clean slate.
      await chrome.storage.local.clear();

      // Write a sentinel value to every key we claim to own.
      const writes: Record<string, string> = {};
      for (const k of keys) writes[k] = "sentinel";
      // Plus two dynamic sync.tracked.<spreadsheetId> entries.
      writes["sync.tracked.abc123"] = "tracked-abc";
      writes["sync.tracked.def456"] = "tracked-def";
      await chrome.storage.local.set(writes);

      // Call destroyAll via the SW-side test bridge.
      await globalThis.__persistentConfigForTests!.destroyAll();

      // Read everything that remains.
      const remaining = await chrome.storage.local.get(null);
      return { remaining };
    }, ALL_KEYS);

    // Nothing this module owns should survive.
    expect(Object.keys(result.remaining)).toEqual([]);
  });
});
