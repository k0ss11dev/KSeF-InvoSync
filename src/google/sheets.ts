// SPDX-License-Identifier: GPL-3.0-or-later
// Google Sheets API v4 client — the minimum surface needed by M2:
//   * createSpreadsheetFromTemplate() — create a fresh spreadsheet pre-populated
//     with the KSeF invoice header row, frozen, ready to append into
//   * appendRows() — append values to the sheet's existing range
//   * mapInvoiceToRow() — convert an InvoiceMetadata to the column order
//     declared by DEFAULT_KSEF_HEADERS
//
// All functions take the API base URL as an optional parameter so e2e tests
// can point at the local mock server instead of sheets.googleapis.com.
//
// Auth: same Google access token from M0's chrome.identity.launchWebAuthFlow
// flow — passed in as a parameter, never read from any global.

import type { InvoiceMetadata } from "../ksef/types";

import { t } from "../shared/i18n";
import { log } from "../shared/logger";

/**
 * Neutralise spreadsheet formula injection. Google Sheets (and Excel) treat
 * cells beginning with `=`, `+`, `-`, `@`, tab, or CR as formulas. KSeF
 * invoice fields (seller name, buyer name, invoice number, etc.) are
 * attacker-controlled from the extension's perspective: anyone who can
 * issue an invoice to the user can put a formula in these fields.
 *
 * Prefixing with a single quote tells Sheets "this is text, not a formula"
 * and the quote itself is not rendered. The `USER_ENTERED` input mode would
 * otherwise happily execute `=HYPERLINK("https://evil/phish",...)` the
 * moment the user opens their Sheet.
 *
 * Applied to every string value in mapInvoiceToRow. Numeric and null values
 * skip this — the guard is a no-op on non-strings but the explicit check
 * keeps the rule obvious for future edits.
 */
export function sanitizeCellValue<T extends string | number | null>(value: T): T {
  if (typeof value !== "string" || value.length === 0) return value;
  const first = value.charCodeAt(0);
  // = 0x3d, + 0x2b, - 0x2d, @ 0x40, \t 0x09, \r 0x0d
  if (
    first === 0x3d ||
    first === 0x2b ||
    first === 0x2d ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0d
  ) {
    return ("'" + value) as T;
  }
  return value;
}

const DEFAULT_API_BASE = "https://sheets.googleapis.com";
const DEFAULT_TAB_NAME = "Invoices";
export const INCOMING_TAB_NAME = "Incoming";
export const DASHBOARD_TAB_NAME = "Dashboard";
export const CHARTS_TAB_NAME = "Charts";

/**
 * Header row written into every fresh spreadsheet by createSpreadsheetFromTemplate.
 * The order here is load-bearing — mapInvoiceToRow() emits values in the same order.
 * Keep this list and `mapInvoiceToRow` in sync.
 */
export const DEFAULT_KSEF_HEADERS: readonly string[] = [
  "KSeF Number",
  "Invoice Number",
  "Issue Date",
  "Permanent Storage Date",
  "Seller NIP",
  "Seller Name",
  "Buyer NIP",
  "Buyer Name",
  "Net Amount",
  "VAT Amount",
  "Gross Amount",
  "Currency",
  "Invoicing Mode",
  "Invoice Type",
];

// --- Types ---------------------------------------------------------------

export type CreateSpreadsheetOpts = {
  accessToken: string;
  title: string;
  tabName?: string;
  headerRow?: readonly string[];
  apiBaseUrl?: string;
};

export type CreatedSpreadsheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  /** Numeric tab id (Sheets calls it `sheetId` — distinct from `spreadsheetId`). */
  sheetId: number;
  tabName: string;
  /** sheetId of the Dashboard tab (for chart targeting). */
  dashboardSheetId?: number;
  /** sheetId of the Invoices tab. */
  invoicesSheetId?: number;
  /** sheetId of the Incoming tab. */
  incomingSheetId?: number;
  /** sheetId of the Charts tab. */
  chartsSheetId?: number;
};

export type AppendRowsOpts = {
  accessToken: string;
  spreadsheetId: string;
  tabName?: string;
  /** Each inner array is one row; cell types can be string, number, boolean, or null. */
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  apiBaseUrl?: string;
};

export type AppendRowsResult = {
  updatedRows: number;
  updatedRange: string;
};

// --- Public API ----------------------------------------------------------

// --- Dashboard tab builder ------------------------------------------------

type CellValue =
  | { userEnteredValue: { stringValue: string }; userEnteredFormat?: Record<string, unknown> }
  | { userEnteredValue: { formulaValue: string } }
  | { userEnteredValue: { numberValue: number } };

function str(text: string, bold = false): CellValue {
  const cell: CellValue = { userEnteredValue: { stringValue: text } };
  if (bold) (cell as Record<string, unknown>).userEnteredFormat = { textFormat: { bold: true } };
  return cell;
}

function formula(f: string): CellValue {
  return { userEnteredValue: { formulaValue: f } };
}

/**
 * Build the Dashboard tab spec with live Sheets formulas referencing the
 * Invoices and Incoming tabs. Layout:
 *
 * A1: "Dashboard"             (bold)
 * A3: "Outgoing invoices"     B3: =COUNTA(Invoices!A:A)-1
 * A4: "Incoming invoices"     B4: =COUNTA(Incoming!A:A)-1
 * A6: "OUTGOING"              (bold section header)
 * A7: "Total Net"             B7: =SUM(Invoices!I:I)
 * A8: "Total VAT"             B8: =SUM(Invoices!J:J)
 * A9: "Total Gross"           B9: =SUM(Invoices!K:K)
 * A11: "INCOMING"             (bold section header)
 * A12: "Total Net"            B12: =SUM(Incoming!I:I)
 * A13: "Total VAT"            B13: =SUM(Incoming!J:J)
 * A14: "Total Gross"          B14: =SUM(Incoming!K:K)
 * A16: "VAT Balance (Out-In)" B16: =SUM(Invoices!J:J)-SUM(Incoming!J:J)
 * A17: "Net Balance (Out-In)" B17: =SUM(Invoices!I:I)-SUM(Incoming!I:I)
 */
function makeDashboardTabSpec() {
  const rows = [
    /* 1  */ { values: [str("Dashboard", true)] },
    /* 2  */ { values: [] },
    /* 3  */ { values: [str("Outgoing invoices"), formula("=COUNTA(Invoices!A:A)-1")] },
    /* 4  */ { values: [str("Incoming invoices"), formula("=COUNTA(Incoming!A:A)-1")] },
    /* 5  */ { values: [] },
    /* 6  */ { values: [str("OUTGOING", true)] },
    /* 7  */ { values: [str("Total Net"), formula("=SUM(Invoices!I:I)")] },
    /* 8  */ { values: [str("Total VAT"), formula("=SUM(Invoices!J:J)")] },
    /* 9  */ { values: [str("Total Gross"), formula("=SUM(Invoices!K:K)")] },
    /* 10 */ { values: [] },
    /* 11 */ { values: [str("INCOMING", true)] },
    /* 12 */ { values: [str("Total Net"), formula("=SUM(Incoming!I:I)")] },
    /* 13 */ { values: [str("Total VAT"), formula("=SUM(Incoming!J:J)")] },
    /* 14 */ { values: [str("Total Gross"), formula("=SUM(Incoming!K:K)")] },
    /* 15 */ { values: [] },
    /* 16 */ { values: [str("VAT Balance (Out − In)", true), formula("=SUM(Invoices!J:J)-SUM(Incoming!J:J)")] },
    /* 17 */ { values: [str("Net Balance (Out − In)", true), formula("=SUM(Invoices!I:I)-SUM(Incoming!I:I)")] },
  ];

  return {
    properties: {
      title: DASHBOARD_TAB_NAME,
      gridProperties: {
        frozenRowCount: 0,
        rowCount: 100,
        columnCount: 10,
      },
    },
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: rows,
      },
    ],
  };
}

/**
 * Create a fresh Google Spreadsheet with one tab and a frozen header row,
 * pre-populated with the KSeF invoice column headers (or whatever headerRow
 * the caller passes). The returned `spreadsheetId` and `sheetId` should be
 * persisted by the caller for subsequent appendRows() calls.
 */
export async function createSpreadsheetFromTemplate(
  opts: CreateSpreadsheetOpts,
): Promise<CreatedSpreadsheet> {
  const baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const tabName = opts.tabName ?? DEFAULT_TAB_NAME;
  const headerRow = opts.headerRow ?? DEFAULT_KSEF_HEADERS;

  // Sheets create-spreadsheet API: POST /v4/spreadsheets, body shape per
  // https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/create
  // We embed the header row in the request as a single inline `data` block,
  // along with frozenRowCount=1, so the new sheet comes back ready to use
  // without a follow-up batchUpdate.
  const makeTabSpec = (title: string, headers: readonly string[]) => ({
    properties: {
      title,
      gridProperties: {
        frozenRowCount: 1,
        rowCount: 1000,
        columnCount: Math.max(headers.length, 26),
      },
    },
    data: [
      {
        startRow: 0,
        startColumn: 0,
        rowData: [
          {
            values: headers.map((text) => ({
              userEnteredValue: { stringValue: text },
              userEnteredFormat: {
                textFormat: { bold: true },
              },
            })),
          },
        ],
      },
    ],
  });

  const requestBody = {
    properties: {
      title: opts.title,
    },
    sheets: [
      makeTabSpec(tabName, headerRow),
      makeTabSpec(INCOMING_TAB_NAME, headerRow),
      makeDashboardTabSpec(),
      // Empty Charts tab — charts are added via batchUpdate after first data append.
      {
        properties: {
          title: CHARTS_TAB_NAME,
          gridProperties: { rowCount: 100, columnCount: 10 },
        },
      },
    ],
  };

  log("info", `Sheets: creating spreadsheet "${opts.title}"`);
  const response = await fetch(`${baseUrl}/v4/spreadsheets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Sheets: create failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `POST ${baseUrl}/v4/spreadsheets failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    spreadsheetId: string;
    spreadsheetUrl: string;
    sheets: Array<{ properties: { sheetId: number; title: string } }>;
  };
  log("info", `Sheets: spreadsheet created id=${json.spreadsheetId}`);

  const firstSheet = json.sheets?.[0];
  if (!firstSheet) {
    throw new Error("Sheets API returned a spreadsheet with no sheets");
  }

  // Build a lookup so we can return IDs for all tabs.
  const sheetsByName = new Map(
    json.sheets.map((s) => [s.properties.title, s.properties.sheetId]),
  );

  return {
    spreadsheetId: json.spreadsheetId,
    spreadsheetUrl: json.spreadsheetUrl,
    sheetId: firstSheet.properties.sheetId,
    tabName: firstSheet.properties.title,
    invoicesSheetId: sheetsByName.get(tabName),
    incomingSheetId: sheetsByName.get(INCOMING_TAB_NAME),
    dashboardSheetId: sheetsByName.get(DASHBOARD_TAB_NAME),
    chartsSheetId: sheetsByName.get(CHARTS_TAB_NAME),
  };
}

/**
 * Append rows to a tab in an existing spreadsheet. Uses the
 * `spreadsheets.values.append` endpoint with `valueInputOption=USER_ENTERED`
 * so numbers come out as numbers and dates as dates (not strings).
 */
export async function appendRows(opts: AppendRowsOpts): Promise<AppendRowsResult> {
  if (opts.rows.length === 0) {
    return { updatedRows: 0, updatedRange: "" };
  }

  const baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const tabName = opts.tabName ?? DEFAULT_TAB_NAME;

  // The range parameter for append is the tab name (Sheets infers the next
  // empty row). encodeURIComponent because tab names can contain spaces.
  const range = encodeURIComponent(tabName);
  const url =
    `${baseUrl}/v4/spreadsheets/${encodeURIComponent(opts.spreadsheetId)}/values/${range}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  log("info", `Sheets: appending ${opts.rows.length} row(s) to tab "${tabName}" (spreadsheet=${opts.spreadsheetId})`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      values: opts.rows,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Sheets: append failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    updates?: { updatedRows?: number; updatedRange?: string };
  };
  const updatedRows = json.updates?.updatedRows ?? 0;
  log("info", `Sheets: append OK — ${updatedRows} row(s) written to ${json.updates?.updatedRange ?? "?"}`);

  return {
    updatedRows,
    updatedRange: json.updates?.updatedRange ?? "",
  };
}

// --- Dashboard charts via batchUpdate ------------------------------------

export type CreateDashboardChartsOpts = {
  accessToken: string;
  spreadsheetId: string;
  invoicesSheetId: number;
  incomingSheetId: number;
  dashboardSheetId: number;
  /** sheetId of the "Charts" tab (where visual charts are placed). */
  chartsSheetId: number;
  apiBaseUrl?: string;
};

/**
 * Add visual charts to the Charts tab via spreadsheets.batchUpdate.
 * Call this AFTER the first sync has populated data rows.
 *
 * Charts created (all on the "Charts" tab):
 *   1. Column chart — outgoing gross by issue date
 *   2. Column chart — incoming gross by issue date
 *   3. Pie chart — outgoing by buyer name
 *   4. Column chart — VAT outgoing vs incoming (side by side)
 *   5. Column chart — monthly net amount (outgoing)
 */
export async function createDashboardCharts(
  opts: CreateDashboardChartsOpts,
): Promise<void> {
  const baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = `${baseUrl}/v4/spreadsheets/${encodeURIComponent(opts.spreadsheetId)}:batchUpdate`;
  const target = opts.chartsSheetId;

  // Column indices (0-based): C=2 (Issue Date), H=7 (Buyer Name),
  // I=8 (Net), J=9 (VAT), K=10 (Gross)
  const COL_DATE = 2;
  const COL_BUYER = 7;
  const COL_NET = 8;
  const COL_VAT = 9;
  const COL_GROSS = 10;

  const makeBasicChart = (
    title: string,
    chartType: string,
    sourceSheetId: number,
    domainCol: number,
    dataCols: number[],
    anchorRow: number,
  ) => ({
    addChart: {
      chart: {
        spec: {
          title,
          basicChart: {
            chartType,
            legendPosition: "BOTTOM_LEGEND",
            domains: [
              {
                domain: {
                  sourceRange: {
                    sources: [{ sheetId: sourceSheetId, startRowIndex: 0, startColumnIndex: domainCol, endColumnIndex: domainCol + 1 }],
                  },
                },
              },
            ],
            series: dataCols.map((col) => ({
              series: {
                sourceRange: {
                  sources: [{ sheetId: sourceSheetId, startRowIndex: 0, startColumnIndex: col, endColumnIndex: col + 1 }],
                },
              },
              targetAxis: "LEFT_AXIS",
            })),
            headerCount: 1,
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: target, rowIndex: anchorRow, columnIndex: 0 },
            widthPixels: 700,
            heightPixels: 350,
          },
        },
      },
    },
  });

  const requests = [
    // 1. Outgoing gross by date
    makeBasicChart(t("chart_outgoing_gross"), "COLUMN", opts.invoicesSheetId, COL_DATE, [COL_GROSS], 0),

    // 2. Incoming gross by date
    makeBasicChart(t("chart_incoming_gross"), "COLUMN", opts.incomingSheetId, COL_DATE, [COL_GROSS], 20),

    // 3. Pie — outgoing by buyer
    {
      addChart: {
        chart: {
          spec: {
            title: t("chart_by_buyer"),
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              domain: {
                sourceRange: { sources: [{ sheetId: opts.invoicesSheetId, startRowIndex: 0, startColumnIndex: COL_BUYER, endColumnIndex: COL_BUYER + 1 }] },
              },
              series: {
                sourceRange: { sources: [{ sheetId: opts.invoicesSheetId, startRowIndex: 0, startColumnIndex: COL_GROSS, endColumnIndex: COL_GROSS + 1 }] },
              },
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: target, rowIndex: 40, columnIndex: 0 },
              widthPixels: 700,
              heightPixels: 400,
            },
          },
        },
      },
    },

    // 4. VAT trend — outgoing VAT vs incoming VAT by date (multi-series)
    {
      addChart: {
        chart: {
          spec: {
            title: t("chart_vat_trend"),
            basicChart: {
              chartType: "LINE",
              legendPosition: "BOTTOM_LEGEND",
              domains: [
                { domain: { sourceRange: { sources: [{ sheetId: opts.invoicesSheetId, startRowIndex: 0, startColumnIndex: COL_DATE, endColumnIndex: COL_DATE + 1 }] } } },
              ],
              series: [
                { series: { sourceRange: { sources: [{ sheetId: opts.invoicesSheetId, startRowIndex: 0, startColumnIndex: COL_VAT, endColumnIndex: COL_VAT + 1 }] } }, targetAxis: "LEFT_AXIS" },
                { series: { sourceRange: { sources: [{ sheetId: opts.incomingSheetId, startRowIndex: 0, startColumnIndex: COL_VAT, endColumnIndex: COL_VAT + 1 }] } }, targetAxis: "LEFT_AXIS" },
              ],
              headerCount: 1,
            },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: target, rowIndex: 62, columnIndex: 0 },
              widthPixels: 700,
              heightPixels: 350,
            },
          },
        },
      },
    },

    // 5. Monthly net — outgoing net by date
    makeBasicChart(t("chart_monthly_net"), "COLUMN", opts.invoicesSheetId, COL_DATE, [COL_NET], 82),
  ];

  log("info", `Sheets: creating ${requests.length} dashboard chart(s) on spreadsheet ${opts.spreadsheetId}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Sheets: chart batchUpdate failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  log("info", "Sheets: dashboard charts created");
}

// --- Mapping -------------------------------------------------------------

/**
 * Convert one InvoiceMetadata into a row of values matching the column order
 * declared by DEFAULT_KSEF_HEADERS. Missing fields become empty strings or
 * null (Sheets renders nulls as empty cells).
 *
 * If you change the column order or add a column, you MUST update both
 * DEFAULT_KSEF_HEADERS and this function — and the test in
 * tests/unit/sheets-mapping.test.ts asserts both arrays stay the same length.
 */
export function mapInvoiceToRow(
  invoice: InvoiceMetadata,
): Array<string | number | null> {
  // All attacker-controlled string fields go through sanitizeCellValue to
  // neutralise spreadsheet formula injection. Numeric fields pass through
  // unchanged so USER_ENTERED input mode still parses them as numbers.
  return [
    sanitizeCellValue(invoice.ksefNumber ?? ""),
    sanitizeCellValue(invoice.invoiceNumber ?? ""),
    sanitizeCellValue(invoice.issueDate ?? ""),
    sanitizeCellValue(invoice.permanentStorageDate ?? ""),
    sanitizeCellValue(invoice.seller?.nip ?? invoice.seller?.identifier?.value ?? ""),
    sanitizeCellValue(invoice.seller?.name ?? ""),
    sanitizeCellValue(invoice.buyer?.nip ?? invoice.buyer?.identifier?.value ?? ""),
    sanitizeCellValue(invoice.buyer?.name ?? ""),
    invoice.netAmount ?? null,
    invoice.vatAmount ?? null,
    invoice.grossAmount ?? null,
    sanitizeCellValue(invoice.currency ?? ""),
    sanitizeCellValue(invoice.invoicingMode ?? ""),
    sanitizeCellValue(invoice.invoiceType ?? ""),
  ];
}

/**
 * Convenience: map a list of invoices to rows in one call.
 */
export function mapInvoicesToRows(
  invoices: readonly InvoiceMetadata[],
): Array<Array<string | number | null>> {
  return invoices.map(mapInvoiceToRow);
}
