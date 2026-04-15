// SPDX-License-Identifier: GPL-3.0-or-later
// M2 sub-turn 1 e2e: drive src/google/sheets.ts against the local Google
// Sheets mock server, end-to-end through the extension's service worker.
// Verifies the Sheets API client constructs the right requests, handles
// the response shape, and persists nothing — the caller (sync orchestrator
// in sub-turn 2) decides where to store the spreadsheetId.

import { expect, test } from "./fixtures/extension";
import {
  startMockGoogleSheetsServer,
  type MockGoogleSheetsServer,
} from "../mocks/google-sheets-server";

const FAKE_GOOGLE_TOKEN = "fake-google-access-token-for-tests";

test.describe("M2 sub-turn 1 — Google Sheets client against mock", () => {
  let mock: MockGoogleSheetsServer;

  test.beforeAll(async () => {
    mock = await startMockGoogleSheetsServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(() => {
    mock.reset();
    mock.setAcceptedAccessToken(FAKE_GOOGLE_TOKEN);
  });

  test("createSpreadsheetFromTemplate creates a sheet with the KSeF header row", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, accessToken }) => {
        const sheets = (
          globalThis as unknown as {
            __sheetsForTests: typeof import("../../src/google/sheets");
          }
        ).__sheetsForTests;
        return sheets.createSpreadsheetFromTemplate({
          apiBaseUrl,
          accessToken,
          title: "KSeF invoices — 2026-04-11",
        });
      },
      { apiBaseUrl: mock.url, accessToken: FAKE_GOOGLE_TOKEN },
    );

    expect(result.spreadsheetId).toMatch(/^mock-ssid-/);
    expect(result.spreadsheetUrl).toContain("docs.google.com/spreadsheets");
    expect(result.sheetId).toBeGreaterThan(0);
    expect(result.tabName).toBe("Invoices");

    // Verify the wire request — the mock recorded the create request body
    // and we check the header row + frozen first row are in there.
    const created = mock.lastCreateRequest as {
      properties?: { title?: string };
      sheets?: Array<{
        properties?: { title?: string; gridProperties?: { frozenRowCount?: number } };
        data?: Array<{
          rowData?: Array<{
            values?: Array<{ userEnteredValue?: { stringValue?: string } }>;
          }>;
        }>;
      }>;
    };

    expect(created.properties?.title).toBe("KSeF invoices — 2026-04-11");
    expect(created.sheets?.[0]?.properties?.title).toBe("Invoices");
    expect(created.sheets?.[0]?.properties?.gridProperties?.frozenRowCount).toBe(1);

    const headerCells =
      created.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.map(
        (v) => v.userEnteredValue?.stringValue,
      ) ?? [];
    expect(headerCells.length).toBe(14);
    expect(headerCells[0]).toBe("KSeF Number");
    expect(headerCells[10]).toBe("Gross Amount");
  });

  test("appendRows POSTs values and reports updatedRows", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, accessToken }) => {
        const sheets = (
          globalThis as unknown as {
            __sheetsForTests: typeof import("../../src/google/sheets");
          }
        ).__sheetsForTests;

        // First create a spreadsheet so the mock has something to append into.
        const created = await sheets.createSpreadsheetFromTemplate({
          apiBaseUrl,
          accessToken,
          title: "Test spreadsheet",
        });

        // Then append three rows.
        const append = await sheets.appendRows({
          apiBaseUrl,
          accessToken,
          spreadsheetId: created.spreadsheetId,
          rows: [
            ["KSeF/1", "FA/1", "2026-04-11", "", "1111111111", "Seller A", "2222222222", "Buyer A", 100, 23, 123, "PLN", "Online", "Vat"],
            ["KSeF/2", "FA/2", "2026-04-11", "", "1111111111", "Seller A", "3333333333", "Buyer B", 200, 46, 246, "PLN", "Online", "Vat"],
            ["KSeF/3", "FA/3", "2026-04-11", "", "1111111111", "Seller A", "4444444444", "Buyer C", 300, 69, 369, "PLN", "Offline", "Vat"],
          ],
        });

        return { spreadsheetId: created.spreadsheetId, append };
      },
      { apiBaseUrl: mock.url, accessToken: FAKE_GOOGLE_TOKEN },
    );

    expect(result.append.updatedRows).toBe(3);
    expect(result.append.updatedRange).toMatch(/Invoices/);
    expect(mock.totalRowsAppended).toBe(3);

    // The mock keeps each created spreadsheet's accumulated rows; verify
    // the header row plus the 3 appended rows ended up there.
    const stored = mock.createdSpreadsheets.get(result.spreadsheetId);
    expect(stored).toBeDefined();
    // 1 header + 3 appended = 4 rows total
    expect(stored!.rows.length).toBe(4);
    expect(stored!.rows[1][0]).toBe("KSeF/1");
    expect(stored!.rows[3][0]).toBe("KSeF/3");
  });

  test("appendRows with an empty rows array is a no-op (no HTTP call)", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, accessToken }) => {
        const sheets = (
          globalThis as unknown as {
            __sheetsForTests: typeof import("../../src/google/sheets");
          }
        ).__sheetsForTests;
        return sheets.appendRows({
          apiBaseUrl,
          accessToken,
          spreadsheetId: "irrelevant-since-no-call-is-made",
          rows: [],
        });
      },
      { apiBaseUrl: mock.url, accessToken: FAKE_GOOGLE_TOKEN },
    );

    expect(result.updatedRows).toBe(0);
    expect(mock.totalRowsAppended).toBe(0);
  });

  test("appendRows surfaces 401 with the unknown access token", async ({
    serviceWorker,
  }) => {
    const errorMessage = await serviceWorker.evaluate(
      async ({ apiBaseUrl }) => {
        const sheets = (
          globalThis as unknown as {
            __sheetsForTests: typeof import("../../src/google/sheets");
          }
        ).__sheetsForTests;
        try {
          await sheets.appendRows({
            apiBaseUrl,
            accessToken: "totally-bogus-token",
            spreadsheetId: "doesnt-matter-rejected-first",
            rows: [["x"]],
          });
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      },
      { apiBaseUrl: mock.url },
    );
    expect(errorMessage).toMatch(/401/);
  });
});
