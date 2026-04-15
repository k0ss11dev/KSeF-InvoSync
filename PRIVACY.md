# Privacy Policy — KSeF InvoSync

**Last updated:** 2026-04-15

## Summary

KSeF InvoSync is a free, open-source browser extension that syncs invoices from the Polish National e-Invoice System (KSeF) to your own Google Sheets.

**We collect nothing. We transmit nothing to our servers. We have no servers.**

All data stays between your browser, the KSeF government API, and your Google account.

## What data the extension handles

### KSeF token (your authentication credential)
- **Stored:** Encrypted in your browser's local storage (`chrome.storage.local`) using PBKDF2 (310,000 iterations) + AES-256-GCM, protected by a passphrase you choose
- **Transmitted to:** `api-test.ksef.mf.gov.pl`, `api-demo.ksef.mf.gov.pl`, or `api.ksef.mf.gov.pl` (your choice) — the Polish government KSeF API
- **Never transmitted anywhere else**

### Passphrase
- **Never stored** — only used to derive an encryption key at runtime
- Optionally, the derived key (not the passphrase itself) can be cached in `chrome.storage.local` (the "Remember passphrase" option) to survive browser restarts

### Google OAuth tokens
- **Stored:** In your browser's `chrome.storage.local` (unencrypted, per standard OAuth practice)
- **Obtained via:** Google's standard OAuth 2.0 + PKCE flow using `chrome.identity.launchWebAuthFlow`
- **Transmitted to:** `accounts.google.com`, `oauth2.googleapis.com`, `sheets.googleapis.com`, `www.googleapis.com` (for Drive API)
- **Scopes requested:** `userinfo.email`, `userinfo.profile`, `drive.file`, `spreadsheets`, `calendar.events`, `calendar.calendarlist.readonly`
- **Note:** `drive.file` is a restricted scope — the extension only sees spreadsheets it created, never other files in your Drive
- **Note:** `calendar.calendarlist.readonly` is used only to populate the "Target calendar" dropdown in settings. It reads the names/IDs of calendars you own — never event contents.

### Invoice data
- **Source:** Your own invoices from KSeF (queries `/invoices/query/metadata` endpoint)
- **Destination:** Your own Google Sheet (created by the extension via Google Sheets API)
- **Intermediate storage:** Recent incoming invoices are cached in `chrome.storage.local` for the in-popup feed (up to 50 items, can be cleared manually)
- **Tracked KSeF reference numbers:** Stored per-spreadsheet to prevent duplicate appends
- **Never sent to any third party**

### Google Calendar events (opt-in feature)
- **Trigger:** Created **only when you click the "Add to Calendar" button** on a specific incoming invoice. Never created automatically.
- **Created on:** The Google Calendar you select in the extension's settings (defaults to your primary calendar). The extension never creates events on calendars you didn't explicitly pick.
- **Event contents:**
  - Title: invoice number + gross amount + currency
  - Description: seller name + NIP, buyer name + NIP, net / VAT / gross amounts, KSeF invoice number
  - Date: invoice payment due date (`TerminPlatnosci/Termin` from the FA(3) XML), all-day event
  - Reminders: two pop-up reminders, 3 days before and 1 day before the due date
- **Mapping stored locally:** When an event is created, the extension stores `{ksefNumber → {eventId, htmlLink, calendarId, addedAt}}` in `chrome.storage.local` (key: `config.invoiceCalendarEvents`). This is used to (a) prevent creating duplicate events for the same invoice, and (b) let you click a feed item's calendar icon to jump straight to the existing event.
- **What the extension does NOT do with Calendar:**
  - Never reads, lists, modifies, or deletes events you didn't create through this button
  - Never reads other people's events on shared calendars
  - Never accesses event attendees, reminders, or details on existing events
- **Disabling the feature:** A master toggle in the Config tab ("Add invoice due dates to Google Calendar") removes the button entirely. Existing event mappings stay in `chrome.storage.local` until you "Reset everything" (events on your calendar are not deleted — uninstall doesn't touch your Calendar).

### Configuration (non-sensitive)
- Auto-sync interval, notification preferences, language choice, dark/light mode, selected KSeF environment, target spreadsheet ID, target Google Calendar ID, "catch up on resume" toggle
- All stored in `chrome.storage.local`

### Idle state (for catch-up sync only)
- The extension listens to `chrome.idle.onStateChanged` to detect when the computer wakes from sleep / unlocks, so it can pull fresh invoices if the last sync is stale
- No idle data is stored or transmitted — only the "active" state event is used as a trigger

## What the extension does NOT do

- ❌ Send any data to a server owned by the developer (there is no such server)
- ❌ Collect analytics, telemetry, or crash reports
- ❌ Track your browsing activity
- ❌ Use third-party tracking / advertising SDKs
- ❌ Share your data with anyone
- ❌ Store your KSeF token in plaintext

## Third-party services

The extension communicates directly with:

| Service | Purpose |
|---|---|
| `api-test.ksef.mf.gov.pl` | KSeF test environment (Polish government) |
| `api-demo.ksef.mf.gov.pl` | KSeF demo environment |
| `api.ksef.mf.gov.pl` | KSeF production environment |
| `oauth2.googleapis.com` | Google OAuth (token exchange, refresh) |
| `sheets.googleapis.com` | Google Sheets API (create + append rows + charts) |
| `www.googleapis.com` | Google Drive API (list app-created spreadsheets) + Calendar API (when user clicks "Add to Calendar") |
| `accounts.google.com` | Google OAuth consent dialog |

These services have their own privacy policies. The extension uses their public APIs as documented.

## Data retention

- **KSeF token:** Until you click "Disconnect KSeF" or destroy the vault
- **Google tokens:** Until you click "Disconnect Google" or revoke access via Google Account settings
- **Incoming invoice feed:** Up to 50 most recent items; can be cleared manually ("Clear all" button) or wiped via "Reset everything"
- **Calendar event mapping** (`config.invoiceCalendarEvents`): Until you "Reset everything" or uninstall. Events created on Google Calendar are not deleted by the extension — manage them in Google Calendar directly.
- **All stored data:** Removed when you uninstall the extension

## Your rights

- **Export:** All your invoice data is already in YOUR Google Sheet — you own it
- **Delete:** Uninstall the extension, or use Settings → "Reset everything" to wipe all local data
- **Revoke Google access:** https://myaccount.google.com/permissions
- **Revoke KSeF access:** Delete the token at ap-test.ksef.mf.gov.pl (or ap.ksef.mf.gov.pl for production)

## Open source

The source code is public at https://github.com/k0ss11dev/KSeF-InvoSync — you can verify every claim in this policy.

Licensed under GPL-3.0-or-later.

## Contact

- Issues: https://github.com/k0ss11dev/KSeF-InvoSync/issues
- Author: k0ss11 (k0ss11dev@gmail.com)
