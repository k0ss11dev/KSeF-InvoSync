// SPDX-License-Identifier: GPL-3.0-or-later
// Typed message protocol between popup and service worker.
// Keep this file tiny and free of imports from src/* — it's shared by both
// surfaces and shouldn't pull either side's runtime dependencies in.

export type Message =
  // Google OAuth (M0)
  | { type: "auth.status" }
  | { type: "auth.connect" }
  | { type: "auth.disconnect" }
  // Vault (M1d)
  | { type: "vault.status" }
  | {
      type: "vault.create";
      passphrase: string;
      ksefToken: string;
      contextNip: string;
    }
  | { type: "vault.unlock"; passphrase: string }
  | { type: "vault.lock" }
  | { type: "vault.destroy" }
  // KSeF sync (M1d)
  | {
      type: "sync.run";
      /** Override the production API base URL — used by e2e tests to point at the local mock. */
      apiBaseUrl?: string;
      fromDate?: string;
      toDate?: string;
    }
  // Sheet picker (M3 sub-turn 2)
  | { type: "sheets.list" }
  | { type: "sheets.getTarget" }
  | { type: "sheets.setTarget"; id: string; name: string }
  | { type: "sheets.clearTarget" }
  // Auto-sync (M3 sub-turn 4)
  | { type: "autoSync.getConfig" }
  | { type: "autoSync.setEnabled"; enabled: boolean }
  | { type: "autoSync.setInterval"; minutes: number }
  // Options / reset (M3 sub-turn 6)
  | { type: "config.destroyAll" }
  | { type: "sheets.clearTracking" }
  // Notifications config
  | { type: "notifications.getConfig" }
  | { type: "notifications.setConfig"; config: Partial<import("../storage/persistent-config").NotificationConfig> }
  // KSeF environment
  | { type: "ksef.getEnvironment" }
  | { type: "ksef.setEnvironment"; env: import("../storage/persistent-config").KsefEnvironment }
  // Connection test
  | { type: "ksef.testConnection" }
  // Fetch raw invoice XML (popup parses it — SW has no DOMParser)
  | { type: "invoice.fetchXml"; ksefNumber: string }
  // Add invoice payment due date to Google Calendar
  | {
      type: "calendar.addInvoiceEvent";
      summary: string;
      description: string;
      date: string;
      ksefNumber: string;
    }
  // Calendar feature master toggle
  | { type: "calendar.enabled.get" }
  | { type: "calendar.enabled.set"; enabled: boolean }
  // Sheets feature master toggle
  | { type: "sheets.enabled.get" }
  | { type: "sheets.enabled.set"; enabled: boolean }
  // Per-direction toggles (outgoing = Subject1, incoming = Subject2)
  | { type: "sheets.syncOutgoing.get" }
  | { type: "sheets.syncOutgoing.set"; enabled: boolean }
  | { type: "sheets.syncIncoming.get" }
  | { type: "sheets.syncIncoming.set"; enabled: boolean }
  // Look up the event link for a previously-added invoice
  | { type: "calendar.getEventForInvoice"; ksefNumber: string }
  | { type: "calendar.getAllEvents" }
  // List the user's Google calendars (for the target-calendar picker)
  | { type: "calendar.list" }
  // Get / set the currently selected target calendar ID
  | { type: "calendar.getTarget" }
  | { type: "calendar.setTarget"; calendarId: string }
  // Debug: retrieve / clear the service-worker log buffer
  | { type: "logs.get" }
  | { type: "logs.clear" }
  // Catch-up on browser start / wake from sleep
  | { type: "fetchOnResume.get" }
  | { type: "fetchOnResume.set"; enabled: boolean }
  // Dashboard stats
  | { type: "dashboard.getStats" }
  // Sheet URL
  | { type: "sheets.getUrl" }
  // Incoming invoice feed
  | { type: "incoming.getRecent" }
  | { type: "incoming.markRead" }
  | { type: "incoming.remove"; ksefNumber: string }
  | { type: "incoming.clearAll" }
  // Remember vault
  | { type: "vault.getRemember" }
  | { type: "vault.setRemember"; enabled: boolean };

export type AuthStatus =
  | { connected: false }
  | { connected: true; email: string };

export type VaultStatus = {
  initialized: boolean;
  unlocked: boolean;
  /** Only meaningful when `unlocked` is true. */
  hasKsefToken: boolean;
  /** Only meaningful when `unlocked` is true. */
  hasContextNip: boolean;
};

/** Mirror of src/ksef/sync.ts RunSyncResult — kept here so the popup doesn't have to import from src/ksef. */
export type SyncResult = {
  totalCount: number;
  durationMs: number;
  syncedAt: string;
  fromDate: string;
  toDate: string;
  // M2 sub-turn 2: only set when a Google access token was available.
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  appendedRows?: number;
  createdSpreadsheet?: boolean;
  // Incoming invoices (Subject2).
  incomingTotal?: number;
  newIncomingCount?: number;
};

/** A row in the sheet picker. */
export type SpreadsheetSummary = {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
};

/** Currently selected target sheet from persistent-config. */
export type TargetSpreadsheet = { id: string; name: string };

/** Auto-sync toggle + its (currently hard-coded) period, for the popup UI. */
export type AutoSyncConfig = {
  enabled: boolean;
  periodMinutes: number;
};

/** A recent incoming invoice for the popup feed. */
export type IncomingInvoiceItem = {
  ksefNumber: string;
  invoiceNumber: string;
  sellerNip: string;
  sellerName: string;
  grossAmount: number;
  currency: string;
  issueDate: string;
  isNew: boolean; // unread
};

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };
