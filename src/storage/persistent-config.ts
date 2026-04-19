// SPDX-License-Identifier: GPL-3.0-or-later
// Non-secret persistent config — lives in chrome.storage.local UNENCRYPTED.
//
// Why this is separate from src/storage/vault.ts:
//
//   The vault is for SECRETS. KSeF tokens, context NIPs (debatable, kept
//   in vault for consistency). Encrypted at rest with PBKDF2 + AES-GCM,
//   protected by a passphrase the user enters per browser session, and —
//   critically — wiped wholesale when `vault.create()` runs (so re-running
//   the setup form starts from a clean slate, no stale credentials lying
//   around).
//
//   This file is for non-secret persistent CONFIG that should survive a
//   vault rebuild. Currently just `targetSpreadsheetId` (the Google Sheet
//   the M2 sync writes into), but the same module will eventually hold:
//
//     - the user's chosen target sheet TITLE / picker selection (M3 sub-turn 2)
//     - the set of synced KSeF reference numbers, for true incremental
//       sync without duplicate rows (M3 sub-turn 3)
//     - the last successful sync timestamp / high-water mark (M3 sub-turn 3)
//
//   The bug fix this turn solves: in M2 the targetSpreadsheetId lived
//   inside the vault, so re-running the setup form created a new sheet on
//   the next sync because vault.create() destroyed the previous spreadsheet
//   ID along with the old credentials. With the ID over here, vault rebuilds
//   leave the sheet selection alone.
//
// Threat model:
//   The Google spreadsheet ID is not a secret — Google's permission model
//   determines who can read the sheet, not the obscurity of the ID. Anyone
//   who already has read access to the user's chrome.storage.local has
//   already pwned the browser process and the vault is moot too.

const TARGET_SPREADSHEET_ID_KEY = "config.targetSpreadsheetId";
const TARGET_SPREADSHEET_NAME_KEY = "config.targetSpreadsheetName";
const AUTO_SYNC_ENABLED_KEY = "config.autoSyncEnabled";
const AUTO_SYNC_INTERVAL_KEY = "config.autoSyncIntervalMin";
const TARGET_SHEET_URL_KEY = "config.targetSheetUrl";
const NOTIFICATION_CONFIG_KEY = "config.notifications";
const INCOMING_TRACKED_KEY = "sync.incoming.tracked";
const INCOMING_FEED_KEY = "sync.incoming.feed";
const INCOMING_READ_KEY = "sync.incoming.lastReadAt";
const KSEF_ENVIRONMENT_KEY = "config.ksefEnvironment";
const LAST_SYNC_STATS_KEY = "sync.lastStats";
const REMEMBER_VAULT_KEY = "config.rememberVault";
const TARGET_CALENDAR_ID_KEY = "config.targetCalendarId";
const FETCH_ON_RESUME_KEY = "config.fetchOnResume";
const CALENDAR_ENABLED_KEY = "config.calendarEnabled";
const INVOICE_CALENDAR_EVENTS_KEY = "config.invoiceCalendarEvents";
const SHEETS_ENABLED_KEY = "config.sheetsEnabled";
const SHEETS_SYNC_OUTGOING_KEY = "config.sheetsSyncOutgoing";
const SHEETS_SYNC_INCOMING_KEY = "config.sheetsSyncIncoming";

// All static config keys this module owns. Used by destroyAll(). Kept as
// an explicit list (rather than inferring from a prefix) so that adding a
// new key without updating this array is a visible change at review time
// — accidental data retention through an un-listed key costs privacy.
const ALL_CONFIG_KEYS: readonly string[] = [
  TARGET_SPREADSHEET_ID_KEY,
  TARGET_SPREADSHEET_NAME_KEY,
  AUTO_SYNC_ENABLED_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  TARGET_SHEET_URL_KEY,
  NOTIFICATION_CONFIG_KEY,
  INCOMING_TRACKED_KEY,
  INCOMING_FEED_KEY,
  INCOMING_READ_KEY,
  KSEF_ENVIRONMENT_KEY,
  LAST_SYNC_STATS_KEY,
  REMEMBER_VAULT_KEY,
  TARGET_CALENDAR_ID_KEY,
  FETCH_ON_RESUME_KEY,
  CALENDAR_ENABLED_KEY,
  INVOICE_CALENDAR_EVENTS_KEY,
  SHEETS_ENABLED_KEY,
  SHEETS_SYNC_OUTGOING_KEY,
  SHEETS_SYNC_INCOMING_KEY,
];

// M3 sub-turn 3: dedup tracking. One list of KSeF reference numbers per
// spreadsheet id, stored under `sync.tracked.<spreadsheetId>`. Keeping them
// in distinct keys (instead of one fat object) means a single sync only
// reads/writes the entry for the target sheet, and switching sheets doesn't
// accidentally pull a stale snapshot of the other one into memory.
const TRACKED_KEY_PREFIX = "sync.tracked.";

function trackedKeyFor(spreadsheetId: string): string {
  return `${TRACKED_KEY_PREFIX}${spreadsheetId}`;
}

export async function setTargetSpreadsheetId(id: string): Promise<void> {
  await chrome.storage.local.set({ [TARGET_SPREADSHEET_ID_KEY]: id });
}

export async function getTargetSpreadsheetId(): Promise<string | null> {
  const result = await chrome.storage.local.get(TARGET_SPREADSHEET_ID_KEY);
  const value = result[TARGET_SPREADSHEET_ID_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function clearTargetSpreadsheetId(): Promise<void> {
  await chrome.storage.local.remove([TARGET_SPREADSHEET_ID_KEY, TARGET_SPREADSHEET_NAME_KEY, TARGET_SHEET_URL_KEY]);
}

export async function getTargetSheetUrl(): Promise<string | null> {
  const result = await chrome.storage.local.get(TARGET_SHEET_URL_KEY);
  const value = result[TARGET_SHEET_URL_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setTargetSheetUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [TARGET_SHEET_URL_KEY]: url });
}

/**
 * Human-readable spreadsheet title. Stored alongside the ID so the popup
 * can show "Target: KSeF invoices — 2026-04-12" instead of the opaque
 * Drive file id "1ME9xBGZLoPdLJ3JFknj6aUbFKPvm5ikvNv1_vFfJIdU".
 */
export async function setTargetSpreadsheetName(name: string): Promise<void> {
  await chrome.storage.local.set({ [TARGET_SPREADSHEET_NAME_KEY]: name });
}

export async function getTargetSpreadsheetName(): Promise<string | null> {
  const result = await chrome.storage.local.get(TARGET_SPREADSHEET_NAME_KEY);
  const value = result[TARGET_SPREADSHEET_NAME_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Convenience: set ID + name in one call.
 */
export async function setTargetSpreadsheet(opts: { id: string; name: string }): Promise<void> {
  await chrome.storage.local.set({
    [TARGET_SPREADSHEET_ID_KEY]: opts.id,
    [TARGET_SPREADSHEET_NAME_KEY]: opts.name,
  });
}

export async function getTargetSpreadsheet(): Promise<{ id: string; name: string } | null> {
  const id = await getTargetSpreadsheetId();
  if (!id) return null;
  const name = (await getTargetSpreadsheetName()) ?? "Untitled";
  return { id, name };
}

// --- Dedup tracking (M3 sub-turn 3) --------------------------------------
//
// True incremental sync: remember which KSeF invoices have already been
// appended to a given spreadsheet, so the next sync appends only NEW rows.
//
// Keyed per spreadsheet id because each sheet has its own column layout
// and its own history — if the user switches targets, they want the new
// sheet to get a fresh backfill, not only the subset of "new since
// whenever the user last synced the OLD sheet".

/**
 * Return the set of KSeF reference numbers already written into this
 * spreadsheet. Returns an empty set if the spreadsheet is unknown (first
 * sync, or recently cleared).
 */
export async function getTrackedKsefNumbers(
  spreadsheetId: string,
): Promise<Set<string>> {
  const key = trackedKeyFor(spreadsheetId);
  const result = await chrome.storage.local.get(key);
  const value = result[key];
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string"));
}

/**
 * Merge `numbers` into the tracked set for this spreadsheet. Idempotent —
 * passing the same numbers twice is a no-op.
 */
export async function addTrackedKsefNumbers(
  spreadsheetId: string,
  numbers: readonly string[],
): Promise<void> {
  if (numbers.length === 0) return;
  const existing = await getTrackedKsefNumbers(spreadsheetId);
  for (const n of numbers) existing.add(n);
  await chrome.storage.local.set({
    [trackedKeyFor(spreadsheetId)]: Array.from(existing),
  });
}

/**
 * Forget all tracked KSeF numbers for this spreadsheet. Used when the user
 * wants to re-sync from scratch (e.g., after manually deleting rows).
 */
export async function clearTrackedKsefNumbers(
  spreadsheetId: string,
): Promise<void> {
  await chrome.storage.local.remove(trackedKeyFor(spreadsheetId));
}

// --- Incoming invoice feed (for popup display) ----------------------------
// Stores the last N incoming invoices with metadata for the messenger-style
// feed in the popup. Separate from the dedup tracking (which is just ksef numbers).

export type IncomingFeedItem = {
  ksefNumber: string;
  invoiceNumber: string;
  sellerNip: string;
  sellerName: string;
  grossAmount: number;
  currency: string;
  issueDate: string;
  syncedAt: string;
};

const MAX_FEED_ITEMS = 50;

export async function getIncomingFeed(): Promise<IncomingFeedItem[]> {
  const result = await chrome.storage.local.get(INCOMING_FEED_KEY);
  const value = result[INCOMING_FEED_KEY];
  if (!Array.isArray(value)) return [];
  return value as IncomingFeedItem[];
}

export async function addToIncomingFeed(items: IncomingFeedItem[]): Promise<void> {
  if (items.length === 0) return;
  const existing = await getIncomingFeed();
  const combined = [...items, ...existing].slice(0, MAX_FEED_ITEMS);
  await chrome.storage.local.set({ [INCOMING_FEED_KEY]: combined });
}

export async function getIncomingLastReadAt(): Promise<string | null> {
  const result = await chrome.storage.local.get(INCOMING_READ_KEY);
  return (result[INCOMING_READ_KEY] as string) ?? null;
}

export async function markIncomingAsRead(): Promise<void> {
  await chrome.storage.local.set({ [INCOMING_READ_KEY]: new Date().toISOString() });
}

export async function removeFromIncomingFeed(ksefNumber: string): Promise<void> {
  const feed = await getIncomingFeed();
  const filtered = feed.filter((item) => item.ksefNumber !== ksefNumber);
  await chrome.storage.local.set({ [INCOMING_FEED_KEY]: filtered });
}

export async function clearIncomingFeed(): Promise<void> {
  await chrome.storage.local.remove(INCOMING_FEED_KEY);
}

// --- Incoming invoice tracking (Subject2) ---------------------------------
// Global notification dedup — just ksef numbers.

export async function getTrackedIncomingKsefNumbers(): Promise<Set<string>> {
  const result = await chrome.storage.local.get(INCOMING_TRACKED_KEY);
  const value = result[INCOMING_TRACKED_KEY];
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string"));
}

export async function addTrackedIncomingKsefNumbers(
  numbers: readonly string[],
): Promise<void> {
  if (numbers.length === 0) return;
  const existing = await getTrackedIncomingKsefNumbers();
  for (const n of numbers) existing.add(n);
  await chrome.storage.local.set({
    [INCOMING_TRACKED_KEY]: Array.from(existing),
  });
}

// --- Auto-sync toggle (M3 sub-turn 4) ------------------------------------
//
// Default is OFF. When enabled, the service worker registers a
// `chrome.alarms` entry that fires every 30 minutes to pull new invoices in
// the background — cheap now that dedup is in place. The alarm is a no-op
// when the vault is locked or Google isn't connected; both are the normal
// state right after browser restart, so "enabled" just means "sync whenever
// you CAN sync".

export async function getAutoSyncEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(AUTO_SYNC_ENABLED_KEY);
  return result[AUTO_SYNC_ENABLED_KEY] === true;
}

export async function setAutoSyncEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_SYNC_ENABLED_KEY]: enabled });
}

export const AUTO_SYNC_MIN_INTERVAL = 1;
export const AUTO_SYNC_DEFAULT_INTERVAL = 30;

export async function getAutoSyncInterval(): Promise<number> {
  const result = await chrome.storage.local.get(AUTO_SYNC_INTERVAL_KEY);
  const value = result[AUTO_SYNC_INTERVAL_KEY];
  if (typeof value === "number" && value >= AUTO_SYNC_MIN_INTERVAL) return value;
  return AUTO_SYNC_DEFAULT_INTERVAL;
}

export async function setAutoSyncInterval(minutes: number): Promise<void> {
  const clamped = Math.max(AUTO_SYNC_MIN_INTERVAL, Math.round(minutes));
  await chrome.storage.local.set({ [AUTO_SYNC_INTERVAL_KEY]: clamped });
}

// --- KSeF environment switcher --------------------------------------------

export type KsefEnvironment = "test" | "demo" | "prod";

export const KSEF_ENVIRONMENTS: Record<
  KsefEnvironment,
  { apiBase: string; webApp: string; label: string; badge: string }
> = {
  test: {
    apiBase: "https://api-test.ksef.mf.gov.pl/v2",
    webApp: "https://ap-test.ksef.mf.gov.pl",
    label: "Test",
    badge: "TEST",
  },
  demo: {
    apiBase: "https://api-demo.ksef.mf.gov.pl/v2",
    webApp: "https://ap-demo.ksef.mf.gov.pl",
    label: "Demo",
    badge: "DEMO",
  },
  prod: {
    apiBase: "https://api.ksef.mf.gov.pl/v2",
    webApp: "https://ap.ksef.mf.gov.pl",
    label: "Produkcja",
    badge: "PROD",
  },
};

export async function getKsefEnvironment(): Promise<KsefEnvironment> {
  const result = await chrome.storage.local.get(KSEF_ENVIRONMENT_KEY);
  const value = result[KSEF_ENVIRONMENT_KEY];
  if (value === "demo" || value === "prod") return value;
  return "test"; // default
}

export async function setKsefEnvironment(env: KsefEnvironment): Promise<void> {
  await chrome.storage.local.set({ [KSEF_ENVIRONMENT_KEY]: env });
}

export function getKsefApiBaseUrl(env: KsefEnvironment): string {
  return KSEF_ENVIRONMENTS[env].apiBase;
}

// --- Last sync stats (for popup dashboard) --------------------------------

export type LastSyncStats = {
  syncedAt: string;
  totalOutgoing: number;
  totalIncoming: number;
  appendedRows: number;
  newIncoming: number;
};

export async function getLastSyncStats(): Promise<LastSyncStats | null> {
  const result = await chrome.storage.local.get(LAST_SYNC_STATS_KEY);
  const stored = result[LAST_SYNC_STATS_KEY];
  if (!stored || typeof stored !== "object") return null;
  return stored as LastSyncStats;
}

export async function setLastSyncStats(stats: LastSyncStats): Promise<void> {
  await chrome.storage.local.set({ [LAST_SYNC_STATS_KEY]: stats });
}

// --- Target calendar for Add-to-Calendar button ---------------------------
// Defaults to "primary" (the user's main Google calendar). Users can switch
// to any calendar they own from the options page.

export async function getTargetCalendarId(): Promise<string> {
  const result = await chrome.storage.local.get(TARGET_CALENDAR_ID_KEY);
  const value = result[TARGET_CALENDAR_ID_KEY];
  return typeof value === "string" && value ? value : "primary";
}

export async function setTargetCalendarId(id: string): Promise<void> {
  await chrome.storage.local.set({ [TARGET_CALENDAR_ID_KEY]: id });
}

// --- Catch-up sync on browser startup / idle-wake ------------------------
// When ON, the service worker triggers a sync on chrome.runtime.onStartup
// and on chrome.idle.onStateChanged -> "active", but only if the last sync
// is older than the configured auto-sync interval (so opening the browser
// right after a recent sync does NOT trigger an extra fetch).

export async function getFetchOnResume(): Promise<boolean> {
  const result = await chrome.storage.local.get(FETCH_ON_RESUME_KEY);
  // Default ON — users generally want fresh data after opening the browser.
  return result[FETCH_ON_RESUME_KEY] !== false;
}

export async function setFetchOnResume(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [FETCH_ON_RESUME_KEY]: enabled });
}

// --- Calendar feature toggle ---------------------------------------------
// Master switch for the "Add to Calendar" button + calendar picker UI.
// Default ON — user can disable it if they don't want Calendar integration.

export async function getCalendarEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(CALENDAR_ENABLED_KEY);
  return result[CALENDAR_ENABLED_KEY] !== false;
}

export async function setCalendarEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [CALENDAR_ENABLED_KEY]: enabled });
}

// --- Invoice → calendar event mapping ------------------------------------
// When the user clicks "Add to Calendar" on an invoice, remember the event
// htmlLink + id so the UI can show "already added" + deep-link to the event
// instead of creating a duplicate.

export type InvoiceCalendarEvent = {
  eventId: string;
  htmlLink: string;
  calendarId: string;
  addedAt: string; // ISO 8601
};

export async function getInvoiceCalendarEvents(): Promise<Record<string, InvoiceCalendarEvent>> {
  const result = await chrome.storage.local.get(INVOICE_CALENDAR_EVENTS_KEY);
  const val = result[INVOICE_CALENDAR_EVENTS_KEY];
  if (!val || typeof val !== "object") return {};
  return val as Record<string, InvoiceCalendarEvent>;
}

export async function getInvoiceCalendarEvent(
  ksefNumber: string,
): Promise<InvoiceCalendarEvent | null> {
  const all = await getInvoiceCalendarEvents();
  return all[ksefNumber] ?? null;
}

export async function setInvoiceCalendarEvent(
  ksefNumber: string,
  event: InvoiceCalendarEvent,
): Promise<void> {
  const all = await getInvoiceCalendarEvents();
  all[ksefNumber] = event;
  await chrome.storage.local.set({ [INVOICE_CALENDAR_EVENTS_KEY]: all });
}

// --- Sheets feature toggle ------------------------------------------------
// Master switch for Google Sheets integration. When OFF, runSync still pulls
// from KSeF for the incoming feed + notifications, but skips the sheet write
// entirely. The sheet picker UI + sheet link are hidden. Calendar and other
// Google features remain unaffected.
// Default ON — the main value prop of the extension is sheet sync.

export async function getSheetsEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(SHEETS_ENABLED_KEY);
  return result[SHEETS_ENABLED_KEY] !== false;
}

export async function setSheetsEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SHEETS_ENABLED_KEY]: enabled });
}

// --- Which invoice types to write to the sheet ---------------------------
// Outgoing = Subject1 (you are the seller), Incoming = Subject2 (you are the
// buyer). Both default ON. Disabling one still lets the other populate its
// tab + reflect in the in-popup feed (incoming) / dashboard.

export async function getSheetsSyncOutgoing(): Promise<boolean> {
  const result = await chrome.storage.local.get(SHEETS_SYNC_OUTGOING_KEY);
  return result[SHEETS_SYNC_OUTGOING_KEY] !== false;
}

export async function setSheetsSyncOutgoing(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SHEETS_SYNC_OUTGOING_KEY]: enabled });
}

export async function getSheetsSyncIncoming(): Promise<boolean> {
  const result = await chrome.storage.local.get(SHEETS_SYNC_INCOMING_KEY);
  return result[SHEETS_SYNC_INCOMING_KEY] !== false;
}

export async function setSheetsSyncIncoming(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SHEETS_SYNC_INCOMING_KEY]: enabled });
}

// --- Remember vault toggle ------------------------------------------------
// When ON, the vault derived key is cached in chrome.storage.local (survives
// browser restart). When OFF, it's only in chrome.storage.session (cleared
// on restart). Default: OFF.

export async function getRememberVault(): Promise<boolean> {
  const result = await chrome.storage.local.get(REMEMBER_VAULT_KEY);
  return result[REMEMBER_VAULT_KEY] === true;
}

export async function setRememberVault(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [REMEMBER_VAULT_KEY]: enabled });
}

// --- Notification config ---------------------------------------------------
// Per-type toggles. Default: all OFF. Stored as a single object.

export type NotificationConfig = {
  syncResult: boolean;
  newInvoices: boolean;
  syncError: boolean;
  incomingInvoices: boolean;
};

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  syncResult: false,
  newInvoices: false,
  syncError: false,
  incomingInvoices: false,
};

export async function getNotificationConfig(): Promise<NotificationConfig> {
  const result = await chrome.storage.local.get(NOTIFICATION_CONFIG_KEY);
  const stored = result[NOTIFICATION_CONFIG_KEY];
  if (!stored || typeof stored !== "object") return { ...DEFAULT_NOTIFICATION_CONFIG };
  return { ...DEFAULT_NOTIFICATION_CONFIG, ...(stored as Partial<NotificationConfig>) };
}

export async function setNotificationConfig(
  config: Partial<NotificationConfig>,
): Promise<void> {
  const current = await getNotificationConfig();
  await chrome.storage.local.set({
    [NOTIFICATION_CONFIG_KEY]: { ...current, ...config },
  });
}

/**
 * Wipe everything this module has ever stored. Used by tests for clean
 * state between runs, and by a future "Forget all settings" button if we
 * ever ship one. Does NOT touch the vault — that has its own destroy().
 */
export async function destroyAll(): Promise<void> {
  // Find every sync.tracked.* key across all spreadsheets so "forget all"
  // really forgets all. chrome.storage.local.get(null) returns everything.
  const everything = await chrome.storage.local.get(null);
  const trackedKeys = Object.keys(everything).filter((k) =>
    k.startsWith(TRACKED_KEY_PREFIX),
  );
  await chrome.storage.local.remove([
    ...ALL_CONFIG_KEYS,
    ...trackedKeys,
  ]);
}
