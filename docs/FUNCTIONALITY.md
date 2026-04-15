# KSeF InvoSync — Functionality

## Overview

KSeF InvoSync is a browser extension (Manifest V3) that connects the Polish National e-Invoice System (KSeF) to Google Sheets. It runs entirely in the browser — no backend server, no cloud infrastructure, no paid services.

```
┌──────────┐    ┌──────────────┐    ┌───────────────┐
│  KSeF    │◄──►│  Extension   │◄──►│ Google Sheets │
│  API     │    │  (your       │    │ (your Google  │
│  (gov)   │    │   browser)   │    │  account)     │
└──────────┘    └──────────────┘    └───────────────┘
```

## Core Features

### 1. Invoice Sync (Outgoing — Subject1)
- Queries KSeF `/invoices/query/metadata` for invoices where you are the **seller**
- Default lookback: 30 days
- Walks all pages automatically (pagination loop)
- Maps invoice metadata to spreadsheet rows (14 columns)
- Appends to the **"Invoices"** tab

### 2. Incoming Invoice Detection (Subject2)
- Second query for invoices where you are the **buyer**
- Incoming invoices go to the **"Incoming"** tab (same spreadsheet)
- Messenger-style feed in the popup with unread badges
- Click any item → **inline invoice viewer**: the SW fetches the FA(3) XML via `/invoices/ksef/{ref}`, the popup parses it with `DOMParser` and renders seller/buyer, line items, totals, payment status, due-date banner (color-coded: green=paid, red=overdue, amber=due soon, blue=future)
- Separate dedup tracking from outgoing

### 2a. Add invoice due date to Google Calendar
- **📅 Add to Calendar** button appears on unpaid invoices (has `TerminPlatnosci/Termin`, no `Zaplacono`)
- Creates an all-day event on the selected calendar via Google Calendar API v3
- Summary + description auto-translated to the extension's active language
- Two popup reminders: 3 days before + 1 day before
- **Target calendar** is user-selectable in Options → Google Account → dropdown populated via Calendar API `calendarList.list` (write-access calendars only)
- Selection persisted in `chrome.storage.local` under `config.targetCalendarId` (default `"primary"`)
- Requires two OAuth scopes: `calendar.events` (write) + `calendar.calendarlist.readonly` (list for picker)

### 3. Deduplication
- Per-spreadsheet tracking of synced KSeF reference numbers
- Stored in `chrome.storage.local` under `sync.tracked.<spreadsheetId>`
- Incoming uses `sync.tracked.<spreadsheetId>.incoming` (per-sheet) + `sync.incoming.tracked` (global, for notifications)
- Switching to a new sheet → full backfill (tracked set is per-sheet)
- Only NEW invoices are ever appended — no duplicates

### 4. Auto-Sync
- Uses `chrome.alarms` API for periodic background sync
- Configurable: 30 min / 1h / 3h / 6h (or off)
- Runs silently when vault is unlocked + Google is connected
- Fires immediately after vault unlock (no wait for first alarm)
- Badge on extension icon shows sync health (colored dot)
- Green progress bar shows countdown to next sync

### 4a. Catch-up on browser start / wake from sleep
- Separate toggle: **"Catch up on browser start / wake from sleep"** (default ON)
- Hooks `chrome.runtime.onStartup` (cold browser launch) and `chrome.idle.onStateChanged → "active"` (system wake / unlock)
- On event, compares `lastSyncStats.syncedAt` against the configured auto-sync interval
- If the gap is ≥ interval, runs a catch-up sync immediately (one-shot, no alarm rescheduling)
- If fresh, logs "skipped — last sync Nmin ago" and does nothing
- Requires the `idle` permission (added in v0.1.0)
- First-sync suppression still applies — freshly-installed extensions don't fire notifications on their initial historical load

### 5. Google Sheets Integration
- Creates spreadsheet with 4 tabs:
  - **Invoices** — outgoing invoice data (frozen header row)
  - **Incoming** — buyer-side invoices
  - **Dashboard** — formula summaries (totals, VAT balance)
  - **Charts** — 5 visual charts (column, line, pie)
- Sheet picker: choose existing or create new
- Dashboard formulas: `=SUM(Invoices!I:I)`, `=COUNTA(...)`, etc.
- Charts: outgoing/incoming gross by date, VAT trend, by buyer, monthly net

### 6. Notifications
- Chrome desktop notifications (configurable per type):
  - Sync completed (count + new rows)
  - New invoices detected
  - Sync errors
  - Incoming invoices from suppliers
- Fires on both manual sync and auto-sync

### 7. Multi-Environment
- KSeF environment switcher: Test / Demo / Production
- Each environment has its own API base URL + web portal URL
- Invoice links in the feed automatically point to the correct portal
- Stored in `chrome.storage.local`, persists across restarts

### 8. Internationalization
- Full PL/EN support (90+ translated strings)
- Manual language selector in settings (independent of browser locale)
- Chart titles, error hints, notifications — all translated
- Uses bundled JSON catalogs via custom `t()` function

### 9. Dark Mode
- Pico CSS framework (~8KB gzipped) for professional styling
- Follows system `prefers-color-scheme` by default
- Manual toggle (☾/☀) in header, persisted in storage
- All custom UI elements use CSS variables

### 10. Diagnostic logs viewer
- Options → **Diagnostic logs** section with Show/Hide/Refresh/Copy/Clear buttons
- [logger.ts](../src/shared/logger.ts) keeps a 300-line in-memory ring buffer per SW lifecycle
- Every `log("info"/"warn"/"error", …)` call prepends `HH:MM:SS.ms [invo-sync] [level]` and pushes into the buffer
- Viewer retrieves the SW buffer via the `logs.get` message — shows auth, sync, Google API (Sheets/Drive/Calendar/Userinfo), and KSeF flow events
- Copy button writes to clipboard via `navigator.clipboard.writeText` — useful for bug reports
- No telemetry, no network transmission — buffer stays in SW memory until it's suspended

## Popup Layout

```
┌─────────────────────────────┐
│ KSeF InvoSync    ☾   [TEST] │
├─────────────────────────────┤
│ [ STATUS ]  [ CONFIG ]      │
├─────────────────────────────┤
│                             │
│  7        18       2min ago │
│  Outgoing Incoming Last sync│
│ ████████████░░░░░░░░░░░░░░ │ ← progress bar
│                             │
│ Incoming invoices        [3]│
│ ┌─────────────────────────┐ │
│ │● Supplier A    4,500 PLN│ │ ← unread (blue)
│ │  FA/2026/042  2026-04-12│ │
│ ├─────────────────────────┤ │
│ │  Supplier B    1,200 PLN│ │
│ │  FA/2026/041  2026-04-11│ │
│ └─────────────────────────┘ │
│                             │
│ [⟳ 1h ▾]  [📊]  [Sync now] │
└─────────────────────────────┘
│        Settings             │
└─────────────────────────────┘
```
