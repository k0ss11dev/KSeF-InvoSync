// SPDX-License-Identifier: GPL-3.0-or-later
// High-level sync orchestration: vault → auth → query → (optional) Google Sheet.
//
// This is the one function the popup's "Sync now" button ultimately calls.
// It assumes the vault is already unlocked (the popup has its own UX flow
// for entering the passphrase). Returns enough metadata for the popup to
// render a "synced N invoices in M seconds" status line.
//
// Google Sheets behaviour (added M2 sub-turn 2):
//   - If `googleAccessToken` is NOT provided, runSync skips the Sheets
//     branch entirely and behaves exactly as it did in M1.
//   - If `googleAccessToken` IS provided AND the vault has no
//     targetSpreadsheetId stored yet, runSync calls
//     `createSpreadsheetFromTemplate()`, persists the new id to the vault,
//     and appends rows to it.
//   - If `googleAccessToken` IS provided AND the vault already has a
//     targetSpreadsheetId, runSync appends to that existing sheet.
//
// What it still doesn't do:
//   - Resume from a high-water mark — that's a v1.5 incremental-sync feature.

import * as sheets from "../google/sheets";
import { log } from "../shared/logger";
import * as persistentConfig from "../storage/persistent-config";
import * as vault from "../storage/vault";
import {
  authenticateWithKsefToken,
  terminateKsefSession,
} from "./auth";
import { queryAllInvoiceMetadata } from "./client";
import type {
  InvoiceMetadata,
  InvoiceQueryDateType,
  InvoiceQuerySubjectType,
} from "./types";

export type RunSyncOpts = {
  // --- KSeF (M1) ---
  apiBaseUrl: string;
  /** ISO 8601 with timezone. Default: 30 days before now. */
  fromDate?: string;
  /** ISO 8601 with timezone. Default: now. */
  toDate?: string;
  /** Default: "Subject1" (querying as the seller — own outgoing invoices). */
  subjectType?: InvoiceQuerySubjectType;
  /** Default: "PermanentStorage" — recommended by the docs for sync. */
  dateType?: InvoiceQueryDateType;
  /** Page size to walk with. Default: 50. Spec range is 10..250. */
  pageSize?: number;

  // --- Google Sheets (M2 sub-turn 2) ---
  /**
   * Google access token from chrome.identity.launchWebAuthFlow. If absent,
   * runSync skips the Sheets branch and behaves exactly like M1.
   */
  googleAccessToken?: string;
  /** Override for the Google Sheets API base URL — used by e2e tests. */
  sheetsApiBaseUrl?: string;
  /** Title for the new spreadsheet if one has to be created. Default: date-stamped. */
  spreadsheetTitle?: string;
  /** Write outgoing (Subject1) invoices to the sheet. Default: true. */
  sheetsSyncOutgoing?: boolean;
  /** Write incoming (Subject2) invoices to the sheet. Default: true. */
  sheetsSyncIncoming?: boolean;
};

export type RunSyncResult = {
  // --- KSeF (M1) ---
  totalCount: number;
  durationMs: number;
  syncedAt: string;
  fromDate: string;
  toDate: string;
  /** First few invoices, for the popup to show as a sample. */
  sample: InvoiceMetadata[];

  // --- Google Sheets (M2 sub-turn 2). Only set if a Google sheet was touched. ---
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  appendedRows?: number;
  /** True if this run created the target spreadsheet (first sync after Google connect). */
  createdSpreadsheet?: boolean;

  // --- Incoming invoices (Subject2 query) ---
  /** Total incoming invoices in the date range. */
  incomingTotal?: number;
  /** How many of those were new since last sync. */
  newIncomingCount?: number;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const SAMPLE_SIZE = 5;

// --- Google Sheets sub-orchestration ------------------------------------

type WriteToSheetOpts = {
  invoices: InvoiceMetadata[];
  googleAccessToken: string;
  sheetsApiBaseUrl?: string;
  spreadsheetTitle?: string;
};

type WriteToSheetResult = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  appendedRows: number;
  createdSpreadsheet: boolean;
};

async function writeToTargetSheet(
  opts: WriteToSheetOpts,
): Promise<WriteToSheetResult> {
  // M3 sub-turn 1: targetSpreadsheetId now lives in persistent-config
  // (chrome.storage.local) instead of the encrypted vault, so vault
  // rebuilds (re-running the setup form) DON'T wipe the user's sheet
  // selection. Old behaviour created a new sheet on the next sync after
  // any vault.create() call.
  let spreadsheetId = await persistentConfig.getTargetSpreadsheetId();
  let spreadsheetUrl = "";
  let createdSpreadsheet = false;
  let chartSheetIds: { invoicesSheetId: number; incomingSheetId: number; dashboardSheetId: number; chartsSheetId: number } | null = null;

  if (!spreadsheetId) {
    // First sync after Google was connected: create a fresh spreadsheet
    // from the KSeF template, store its ID + name in persistent-config,
    // and use it.
    const title =
      opts.spreadsheetTitle ??
      `KSeF invoices — ${new Date().toISOString().slice(0, 10)}`;
    log("info", `Creating new target spreadsheet: ${title}`);
    const created = await sheets.createSpreadsheetFromTemplate({
      apiBaseUrl: opts.sheetsApiBaseUrl,
      accessToken: opts.googleAccessToken,
      title,
    });
    spreadsheetId = created.spreadsheetId;
    spreadsheetUrl = created.spreadsheetUrl;
    createdSpreadsheet = true;
    // Store IDs so we can create charts after first data append.
    chartSheetIds = {
      invoicesSheetId: created.invoicesSheetId ?? 0,
      incomingSheetId: created.incomingSheetId ?? 0,
      dashboardSheetId: created.dashboardSheetId ?? 0,
      chartsSheetId: created.chartsSheetId ?? 0,
    };
    await persistentConfig.setTargetSpreadsheet({ id: spreadsheetId, name: title });
    await persistentConfig.setTargetSheetUrl(spreadsheetUrl);
    log("info", `Stored target spreadsheet in persistent-config: ${title} (${spreadsheetId})`);
  } else {
    // Subsequent sync: we have a stored ID but we don't know the URL
    // (we didn't persist it — only the ID is needed for the API). Build
    // the canonical URL from the ID. The user can also see the title in
    // the sheet itself when they open it.
    spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  }

  // M3 sub-turn 3: dedup. Filter out invoices we've already written to
  // this spreadsheet. The tracked set lives per-spreadsheet in
  // persistent-config, so switching targets gives the new sheet a fresh
  // backfill and the old one remembers its own history.
  //
  // For a freshly created sheet (above), the tracked set is empty, so
  // this filter is a no-op — all invoices get appended on first sync.
  const tracked = await persistentConfig.getTrackedKsefNumbers(spreadsheetId);
  const newInvoices = opts.invoices.filter(
    (inv) => !tracked.has(inv.ksefNumber),
  );
  const skippedCount = opts.invoices.length - newInvoices.length;
  if (skippedCount > 0) {
    log("info", `Dedup: skipping ${skippedCount} already-synced invoice(s)`);
  }

  if (newInvoices.length === 0) {
    return {
      spreadsheetId,
      spreadsheetUrl,
      appendedRows: 0,
      createdSpreadsheet,
    };
  }

  const rows = sheets.mapInvoicesToRows(newInvoices);
  const append = await sheets.appendRows({
    apiBaseUrl: opts.sheetsApiBaseUrl,
    accessToken: opts.googleAccessToken,
    spreadsheetId,
    rows,
  });

  // Record the new ksef numbers so the next sync skips them. We do this
  // AFTER the append succeeds — if the append throws, the tracked set
  // stays untouched and the next sync will retry those rows.
  await persistentConfig.addTrackedKsefNumbers(
    spreadsheetId,
    newInvoices.map((inv) => inv.ksefNumber),
  );

  log(
    "info",
    `Appended ${append.updatedRows} row(s) to spreadsheet ${spreadsheetId}`,
  );

  // Create dashboard charts on the first sync (when we just created the sheet
  // and have data to chart). Non-fatal — charts are nice-to-have.
  if (createdSpreadsheet && chartSheetIds) {
    try {
      await sheets.createDashboardCharts({
        accessToken: opts.googleAccessToken,
        spreadsheetId,
        apiBaseUrl: opts.sheetsApiBaseUrl,
        ...chartSheetIds,
      });
      log("info", "Dashboard charts created");
    } catch (err) {
      log("warn", "Failed to create dashboard charts (non-fatal):", err);
    }
  }

  return {
    spreadsheetId,
    spreadsheetUrl,
    appendedRows: append.updatedRows,
    createdSpreadsheet,
  };
}

/**
 * Run the full sync: read credentials from the vault, authenticate against
 * KSeF, query invoices for the date range, return the row count.
 *
 * Throws meaningful errors at every step:
 *   - Vault locked         → "Vault is locked, unlock with passphrase first"
 *   - No KSeF token        → "No KSeF token stored. Add one in settings."
 *   - No context NIP       → "No context NIP stored. Add one in settings."
 *   - Auth failure         → propagated from authenticateWithKsefToken
 *   - Query failure        → propagated from queryAllInvoiceMetadata
 */
export async function runSync(opts: RunSyncOpts): Promise<RunSyncResult> {
  const startedAt = Date.now();

  if (!vault.isUnlocked()) {
    throw new Error("Vault is locked. Unlock with your passphrase first.");
  }

  const ksefToken = await vault.getKsefToken();
  if (!ksefToken) {
    throw new Error(
      "No KSeF token stored in the vault. Add one in settings before syncing.",
    );
  }

  const contextNip = await vault.getContextNip();
  if (!contextNip) {
    throw new Error(
      "No context NIP stored in the vault. Add one in settings before syncing.",
    );
  }

  const toDate = opts.toDate ?? new Date(startedAt).toISOString();
  const fromDate =
    opts.fromDate ??
    new Date(startedAt - DEFAULT_LOOKBACK_DAYS * 24 * 3600_000).toISOString();

  log("info", `KSeF sync starting: ${fromDate} → ${toDate}`);

  const session = await authenticateWithKsefToken({
    apiBaseUrl: opts.apiBaseUrl,
    ksefToken,
    contextIdentifier: { type: "Nip", value: contextNip },
  });

  try {
    const invoices = await queryAllInvoiceMetadata({
      apiBaseUrl: opts.apiBaseUrl,
      accessToken: session.accessToken.token,
      filters: {
        subjectType: opts.subjectType ?? "Subject1",
        dateRange: {
          dateType: opts.dateType ?? "PermanentStorage",
          from: fromDate,
          to: toDate,
        },
      },
      pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
      sortOrder: "Asc",
    });

    const result: RunSyncResult = {
      totalCount: invoices.length,
      durationMs: Date.now() - startedAt,
      syncedAt: new Date().toISOString(),
      fromDate,
      toDate,
      sample: invoices.slice(0, SAMPLE_SIZE),
    };

    // --- M2: optional Google Sheet write ---
    // Skipped entirely when no Google token is supplied — M1 behaviour
    // remains the default. With a token, the first sync creates the
    // target sheet from the KSeF template and stores its ID in the vault;
    // subsequent syncs append to the same sheet.
    // Outgoing rows are skipped when opts.sheetsSyncOutgoing is explicitly
    // false. Even when skipped, we still call writeToTargetSheet-lite to
    // discover the spreadsheetId so the incoming branch below can append.
    const syncOutgoing = opts.sheetsSyncOutgoing !== false;
    const syncIncoming = opts.sheetsSyncIncoming !== false;
    if (opts.googleAccessToken) {
      if (syncOutgoing) {
        const sheetsResult = await writeToTargetSheet({
          invoices,
          googleAccessToken: opts.googleAccessToken,
          sheetsApiBaseUrl: opts.sheetsApiBaseUrl,
          spreadsheetTitle: opts.spreadsheetTitle,
        });
        result.spreadsheetId = sheetsResult.spreadsheetId;
        result.spreadsheetUrl = sheetsResult.spreadsheetUrl;
        result.appendedRows = sheetsResult.appendedRows;
        result.createdSpreadsheet = sheetsResult.createdSpreadsheet;
      } else if (syncIncoming) {
        // Outgoing is off but incoming is on — resolve the spreadsheet so
        // incoming rows can still land somewhere. No outgoing writes happen.
        const sheetsResult = await writeToTargetSheet({
          invoices: [],
          googleAccessToken: opts.googleAccessToken,
          sheetsApiBaseUrl: opts.sheetsApiBaseUrl,
          spreadsheetTitle: opts.spreadsheetTitle,
        });
        result.spreadsheetId = sheetsResult.spreadsheetId;
        result.spreadsheetUrl = sheetsResult.spreadsheetUrl;
        result.appendedRows = 0;
        result.createdSpreadsheet = sheetsResult.createdSpreadsheet;
      }
    }

    // --- Incoming invoices (Subject2) ---
    // Run a second query to detect invoices where we are the BUYER. New
    // incoming invoices are written to the "Incoming" tab of the same
    // target spreadsheet (if Google is connected + sheet exists). The
    // dedup set is separate from the per-sheet outgoing tracking.
    try {
      const incoming = await queryAllInvoiceMetadata({
        apiBaseUrl: opts.apiBaseUrl,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject2",
          dateRange: {
            dateType: opts.dateType ?? "PermanentStorage",
            from: fromDate,
            to: toDate,
          },
        },
        pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
        sortOrder: "Asc",
      });
      result.incomingTotal = incoming.length;
      log("info", `Incoming query (Subject2): ${incoming.length} invoice(s) returned by KSeF`);

      // --- Notification dedup (global) ---
      // "newIncomingCount" drives notifications — uses the global tracker
      // so the user isn't re-notified for invoices they've already seen,
      // regardless of which sheet is targeted.
      const trackedIncoming = await persistentConfig.getTrackedIncomingKsefNumbers();
      const newForNotification = incoming.filter(
        (inv) => !trackedIncoming.has(inv.ksefNumber),
      );
      result.newIncomingCount = newForNotification.length;
      log(
        "info",
        `Incoming dedup: ${trackedIncoming.size} tracked, ${newForNotification.length} new`,
      );
      if (newForNotification.length > 0) {
        await persistentConfig.addTrackedIncomingKsefNumbers(
          newForNotification.map((inv) => inv.ksefNumber),
        );
        // Add to the incoming feed for popup display.
        const now = new Date().toISOString();
        await persistentConfig.addToIncomingFeed(
          newForNotification.map((inv) => ({
            ksefNumber: inv.ksefNumber,
            invoiceNumber: inv.invoiceNumber,
            sellerNip: inv.seller?.nip ?? inv.seller?.identifier?.value ?? "",
            sellerName: inv.seller?.name ?? "",
            grossAmount: inv.grossAmount ?? 0,
            currency: inv.currency ?? "PLN",
            issueDate: inv.issueDate,
            syncedAt: now,
          })),
        );
      }

      // --- Sheet write dedup (per-spreadsheet) ---
      // Uses the same per-sheet tracking as outgoing, but with a
      // ".incoming" suffix so each sheet gets a full backfill of
      // incoming invoices when first targeted. Gated by sheetsSyncIncoming.
      if (opts.googleAccessToken && syncIncoming && result.spreadsheetId) {
        const sheetIncomingKey = `${result.spreadsheetId}.incoming`;
        const trackedForSheet = await persistentConfig.getTrackedKsefNumbers(sheetIncomingKey);
        const newForSheet = incoming.filter(
          (inv) => !trackedForSheet.has(inv.ksefNumber),
        );
        if (newForSheet.length > 0) {
          const incomingRows = sheets.mapInvoicesToRows(newForSheet);
          await sheets.appendRows({
            apiBaseUrl: opts.sheetsApiBaseUrl,
            accessToken: opts.googleAccessToken,
            spreadsheetId: result.spreadsheetId,
            tabName: sheets.INCOMING_TAB_NAME,
            rows: incomingRows,
          });
          await persistentConfig.addTrackedKsefNumbers(
            sheetIncomingKey,
            newForSheet.map((inv) => inv.ksefNumber),
          );
          log(
            "info",
            `Appended ${newForSheet.length} incoming invoice(s) to "${sheets.INCOMING_TAB_NAME}" tab`,
          );
        }
      }
    } catch (err) {
      // Non-fatal: incoming query failure shouldn't break the main sync.
      log("warn", "Incoming invoice query failed (non-fatal):", err);
    }

    log(
      "info",
      `KSeF sync done: ${invoices.length} invoices in ${result.durationMs}ms`,
    );
    return result;
  } finally {
    // Best-effort session revocation. The KSeF docs note that DELETE
    // /auth/sessions/current invalidates the refresh token bound to the
    // session — existing access tokens remain valid until expiry. We don't
    // want a stale refresh token sitting around after a one-shot sync, so
    // we revoke. Errors here are non-fatal because the sync result is the
    // important thing, and the access token will expire on its own anyway.
    try {
      await terminateKsefSession({
        apiBaseUrl: opts.apiBaseUrl,
        accessToken: session.accessToken.token,
      });
    } catch (err) {
      log("warn", "Failed to terminate KSeF session after sync (non-fatal):", err);
    }
  }
}
