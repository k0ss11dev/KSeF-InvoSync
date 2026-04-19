// SPDX-License-Identifier: GPL-3.0-or-later
// MV3 background service worker (Chrome) / background module script (Firefox).
// Hosts the message router for the popup and orchestrates Google OAuth.
// Stateless between events — all persistence goes through chrome.storage.*.

import { getStoredToken, revokeGoogleAuth, startGoogleAuth } from "../google/auth";
import { listAppCreatedSpreadsheets } from "../google/drive";
import { fetchUserInfo } from "../google/userinfo";
import type {
  AutoSyncConfig,
  AuthStatus,
  Message,
  Response,
  SpreadsheetSummary,
  SyncResult,
  TargetSpreadsheet,
  VaultStatus,
} from "../shared/messages";
import { log } from "../shared/logger";
import { runSync } from "../ksef/sync";
import * as persistentConfigMod from "../storage/persistent-config";
import * as vaultMod from "../storage/vault";
import {
  AUTO_SYNC_ALARM_NAME,
  catchUpSyncIfStale,
  ensureAlarmMatchesConfig,
  runBackgroundSyncIfReady,
} from "./auto-sync";
import * as autoSyncMod from "./auto-sync";
import {
  notifyIncomingInvoices,
  notifyNewInvoices,
  notifySyncResult,
} from "./notifications";

// KSeF API base URL: resolved dynamically from the user's chosen environment
// (test/demo/prod) stored in persistent-config. e2e tests override via
// globalThis.__ksefApiBaseUrlOverride which takes priority over the config.

/**
 * Production Google Sheets API base URL. e2e tests override via
 * `globalThis.__sheetsApiBaseUrlOverride` so popup-driven syncs hit the
 * local mock instead of sheets.googleapis.com.
 */
const SHEETS_API_BASE_URL = "https://sheets.googleapis.com";
import * as vault from "../storage/vault";
import * as persistentConfig from "../storage/persistent-config";
import * as ksefCert from "../ksef/cert";
import * as ksefAuth from "../ksef/auth";
import * as ksefClient from "../ksef/client";
import * as ksefSync from "../ksef/sync";
import * as ksefUpload from "../ksef/upload";
import * as fa3Builder from "../ksef/fa3-builder";
import * as fa3TestData from "../ksef/fa3-test-data";
import * as googleSheets from "../google/sheets";
import * as googleDrive from "../google/drive";

// Test bridges: expose internal modules on globalThis so e2e tests can call
// them via serviceWorker.evaluate(). Gated behind the __TEST_BRIDGES__ build
// flag (true in dev builds, false when BUILD_FOR_STORE=1) so store builds
// strip this block entirely via esbuild's dead-code elimination — removing
// an attack surface where any code running in the SW context could call
// globalThis.__vaultForTests.getKsefToken() while the vault is unlocked.
if (__TEST_BRIDGES__) {
  (globalThis as unknown as { __vaultForTests: typeof vault }).__vaultForTests = vault;
  (globalThis as unknown as { __persistentConfigForTests: typeof persistentConfig }).__persistentConfigForTests = persistentConfig;
  (globalThis as unknown as { __ksefForTests: typeof ksefCert }).__ksefForTests = ksefCert;
  (globalThis as unknown as { __ksefAuthForTests: typeof ksefAuth }).__ksefAuthForTests = ksefAuth;
  (globalThis as unknown as { __ksefClientForTests: typeof ksefClient }).__ksefClientForTests = ksefClient;
  (globalThis as unknown as { __ksefSyncForTests: typeof ksefSync }).__ksefSyncForTests = ksefSync;
  (globalThis as unknown as { __ksefUploadForTests: typeof ksefUpload }).__ksefUploadForTests = ksefUpload;
  (globalThis as unknown as { __fa3BuilderForTests: typeof fa3Builder }).__fa3BuilderForTests = fa3Builder;
  (globalThis as unknown as { __fa3TestDataForTests: typeof fa3TestData }).__fa3TestDataForTests = fa3TestData;
  (globalThis as unknown as { __sheetsForTests: typeof googleSheets }).__sheetsForTests = googleSheets;
  (globalThis as unknown as { __driveForTests: typeof googleDrive }).__driveForTests = googleDrive;
  (globalThis as unknown as { __autoSyncForTests: typeof autoSyncMod }).__autoSyncForTests = autoSyncMod;
}

// --- Auto-sync wiring (M3 sub-turn 4) ------------------------------------
// The alarm is driven by a flag in persistent-config (default OFF). On SW
// load + browser startup we re-ensure the alarm matches the stored flag —
// MV3 service workers get suspended and restarted frequently, so this has
// to be idempotent. The actual sync runs in the onAlarm listener and in a
// hook called right after vault.unlock (so users get an immediate sync
// when they open the popup and unlock, without waiting up to 30 min).

chrome.alarms.onAlarm.addListener((alarm) => {
  log("info", `[autosync-debug] onAlarm fired: name=${alarm.name}`);
  if (alarm.name !== AUTO_SYNC_ALARM_NAME) return;
  void runBackgroundSyncIfReady()
    .then((res) => {
      log("info", `[autosync-debug] runBackgroundSyncIfReady → ${JSON.stringify(res)}`);
    })
    .catch((err) => {
      log("warn", "onAlarm handler threw (non-fatal):", err);
    });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarmMatchesConfig().catch((err) => {
    log("warn", "onStartup ensureAlarmMatchesConfig failed:", err);
  });
  void catchUpSyncIfStale("startup").catch((err) => {
    log("warn", "onStartup catch-up failed:", err);
  });
});

// Wake from system sleep / user unlock. The onStateChanged event fires with
// "active" whenever the user returns after the OS idle threshold (default
// 60s, configurable via chrome.idle.setDetectionInterval). If the last sync
// is older than the configured interval, pull fresh data.
chrome.idle.onStateChanged.addListener((newState) => {
  if (newState !== "active") return;
  void catchUpSyncIfStale("idle-wake").catch((err) => {
    log("warn", "idle-wake catch-up failed:", err);
  });
});

// Re-ensure on every SW wake. This is the critical path for MV3 — Chrome
// persists alarms across SW suspensions, but the listener registration
// above has to happen synchronously at module load for the alarm to
// actually deliver events when it fires. Calling ensureAlarmMatchesConfig
// here also handles the "enable flag was toggled while SW was asleep"
// case (popup could, in theory, write directly to storage, though in
// practice it goes through the message router below).
void chrome.alarms.getAll().then((alarms) => {
  log(
    "info",
    `[autosync-debug] SW wake — existing alarms: ${JSON.stringify(
      alarms.map((a) => ({ name: a.name, period: a.periodInMinutes, inSec: Math.round((a.scheduledTime - Date.now()) / 1000) })),
    )}`,
  );
});
void ensureAlarmMatchesConfig().catch((err) => {
  log("warn", "initial ensureAlarmMatchesConfig failed:", err);
});

// Restore vault unlock state from session cache. MV3 service workers get
// suspended after ~30s idle; this re-hydrates the derived key so the vault
// stays "unlocked" for the entire browser session without re-entering the
// passphrase. The session cache is cleared on browser restart.
void vaultMod.restoreFromSession().then(async (restored) => {
  if (restored) {
    log("info", "Vault key restored from session cache");
    void autoSyncMod.updateBadge("ok");
  } else {
    const autoEnabled = await persistentConfigMod.getAutoSyncEnabled().catch(() => false);
    if (autoEnabled) {
      void autoSyncMod.updateBadge("locked");
    }
  }

  // Restore unread badge count on SW wake / extension reload. The icon badge
  // lives in memory and is cleared whenever the SW restarts. Re-compute from
  // the persisted feed + lastReadAt so the count survives reloads.
  try {
    const feed = await persistentConfigMod.getIncomingFeed();
    const lastRead = await persistentConfigMod.getIncomingLastReadAt();
    const unreadCount = feed.filter((i) => !lastRead || i.syncedAt > lastRead).length;
    if (unreadCount > 0) {
      void autoSyncMod.setUnreadBadge(unreadCount);
    }
  } catch {
    // Non-fatal — badge just stays empty until next sync
  }
}).catch((err) => {
  log("warn", "vault restoreFromSession failed:", err);
});

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Defense-in-depth: only accept messages from our own extension. Today
  // nothing external can reach this listener (no externally_connectable, no
  // content scripts), but a future change could relax those constraints.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg)
    .then(sendResponse)
    .catch((err: unknown) => {
      log("error", "Message handler failed:", err);
      sendResponse({ ok: false, error: (err as Error).message ?? String(err) });
    });
  return true; // keep the message channel open for the async response
});

async function handle(msg: Message): Promise<Response> {
  switch (msg.type) {
    // --- Google OAuth ----------------------------------------------------
    case "auth.status": {
      const token = await getStoredToken();
      if (!token) {
        const data: AuthStatus = { connected: false };
        return { ok: true, data };
      }
      try {
        const user = await fetchUserInfo(token.accessToken);
        const data: AuthStatus = { connected: true, email: user.email };
        return { ok: true, data };
      } catch (err) {
        log("warn", "Stored token appears invalid, clearing:", err);
        await revokeGoogleAuth();
        const data: AuthStatus = { connected: false };
        return { ok: true, data };
      }
    }

    case "auth.connect": {
      const token = await startGoogleAuth();
      const user = await fetchUserInfo(token.accessToken);
      return { ok: true, data: { email: user.email } };
    }

    case "auth.disconnect": {
      await revokeGoogleAuth();
      return { ok: true, data: null };
    }

    // --- Vault -----------------------------------------------------------
    case "vault.status": {
      const initialized = await vaultMod.isInitialized();
      const unlocked = vaultMod.isUnlocked();
      let hasKsefToken = false;
      let hasContextNip = false;
      if (unlocked) {
        hasKsefToken = (await vaultMod.getKsefToken()) !== null;
        hasContextNip = (await vaultMod.getContextNip()) !== null;
      }
      const data: VaultStatus = {
        initialized,
        unlocked,
        hasKsefToken,
        hasContextNip,
      };
      return { ok: true, data };
    }

    case "vault.create": {
      // Always start from a clean slate. If the user is reconfiguring an
      // existing vault from this popup, the previous one is replaced.
      await vaultMod.destroy();
      await vaultMod.create(msg.passphrase);
      await vaultMod.setKsefToken(msg.ksefToken);
      await vaultMod.setContextNip(msg.contextNip);
      return { ok: true, data: null };
    }

    case "vault.unlock": {
      const unlocked = await vaultMod.unlock(msg.passphrase);
      // M3 sub-turn 4: if auto-sync is enabled, kick off one immediate
      // background sync right after unlock so users get fresh data the
      // moment they walk into the extension — instead of waiting up to
      // 30 minutes for the next alarm tick. Fire-and-forget; any failure
      // is logged by runBackgroundSyncIfReady and does not affect the
      // unlock response.
      if (unlocked) {
        // Clear the "locked" badge now that the vault is open.
        void autoSyncMod.updateBadge("ok");
        void runBackgroundSyncIfReady().catch((err) => {
          log("warn", "post-unlock auto-sync threw (non-fatal):", err);
        });
      }
      return { ok: true, data: { unlocked } };
    }

    case "vault.lock": {
      vaultMod.lock();
      return { ok: true, data: null };
    }

    case "vault.destroy": {
      await vaultMod.destroy();
      return { ok: true, data: null };
    }

    case "vault.getRemember": {
      const remember = await persistentConfigMod.getRememberVault();
      return { ok: true, data: { remember } };
    }

    case "vault.setRemember": {
      await persistentConfigMod.setRememberVault(msg.enabled);
      if (msg.enabled && vaultMod.isUnlocked()) {
        // Re-cache to local storage now that remember is on.
        await vaultMod.reCacheKey();
      } else if (!msg.enabled) {
        // Clear persistent cache when remember is turned off.
        await chrome.storage.local.remove("vault.persistentKey").catch(() => {});
      }
      return { ok: true, data: null };
    }

    // --- Sheet picker (M3 sub-turn 2) ------------------------------------
    case "sheets.list": {
      const googleToken = await getStoredToken();
      if (!googleToken) {
        return { ok: false, error: "Not connected to Google" };
      }
      const sheetsOverride = (
        globalThis as unknown as { __sheetsApiBaseUrlOverride?: string }
      ).__sheetsApiBaseUrlOverride;
      const list = await listAppCreatedSpreadsheets({
        accessToken: googleToken.accessToken,
        apiBaseUrl: sheetsOverride ?? undefined,
      });
      const data: SpreadsheetSummary[] = list;
      return { ok: true, data };
    }

    case "sheets.getTarget": {
      const target = await persistentConfigMod.getTargetSpreadsheet();
      const data: TargetSpreadsheet | null = target;
      return { ok: true, data };
    }

    case "sheets.setTarget": {
      await persistentConfigMod.setTargetSpreadsheet({
        id: msg.id,
        name: msg.name,
      });
      return { ok: true, data: null };
    }

    case "sheets.clearTarget": {
      await persistentConfigMod.clearTargetSpreadsheetId();
      return { ok: true, data: null };
    }

    // --- Auto-sync (M3 sub-turn 4) ---------------------------------------
    case "autoSync.getConfig": {
      const enabled = await persistentConfigMod.getAutoSyncEnabled();
      const periodMinutes = await persistentConfigMod.getAutoSyncInterval();
      const data: AutoSyncConfig = { enabled, periodMinutes };
      return { ok: true, data };
    }

    case "autoSync.setEnabled": {
      await persistentConfigMod.setAutoSyncEnabled(msg.enabled);
      await ensureAlarmMatchesConfig();
      return { ok: true, data: null };
    }

    case "autoSync.setInterval": {
      await persistentConfigMod.setAutoSyncInterval(msg.minutes);
      await ensureAlarmMatchesConfig(); // re-create alarm with new period
      return { ok: true, data: null };
    }

    // --- Connection test ---------------------------------------------------
    case "ksef.testConnection": {
      if (!vaultMod.isUnlocked()) {
        return { ok: false, error: "Vault is locked" };
      }
      const ksefToken = await vaultMod.getKsefToken();
      const contextNip = await vaultMod.getContextNip();
      if (!ksefToken || !contextNip) {
        return { ok: false, error: "Missing KSeF token or NIP" };
      }
      const ksefOverride = (
        globalThis as unknown as { __ksefApiBaseUrlOverride?: string }
      ).__ksefApiBaseUrlOverride;
      const ksefEnv = await persistentConfigMod.getKsefEnvironment();
      const ksefBaseUrl = persistentConfigMod.getKsefApiBaseUrl(ksefEnv);
      const apiBase = ksefOverride ?? ksefBaseUrl;

      // Import auth + client modules
      const { authenticateWithKsefToken, terminateKsefSession } = await import("../ksef/auth");
      const { queryInvoiceMetadata } = await import("../ksef/client");

      const session = await authenticateWithKsefToken({
        apiBaseUrl: apiBase,
        ksefToken,
        contextIdentifier: { type: "Nip", value: contextNip },
      });
      // Quick query to verify data access
      const probe = await queryInvoiceMetadata({
        apiBaseUrl: apiBase,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject1",
          dateRange: {
            dateType: "PermanentStorage",
            from: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
            to: new Date().toISOString(),
          },
        },
        pageSize: 10,
      });
      // Revoke session
      void terminateKsefSession({ apiBaseUrl: apiBase, accessToken: session.accessToken.token }).catch(() => {});

      return {
        ok: true,
        data: {
          authenticated: true,
          invoiceCount: probe.invoices.length,
          hasMore: probe.hasMore,
        },
      };
    }

    case "calendar.addInvoiceEvent": {
      const googleToken = await getStoredToken();
      if (!googleToken) {
        return { ok: false, error: "Not connected to Google" };
      }
      const { createCalendarEvent } = await import("../google/calendar");
      const calendarId = await persistentConfigMod.getTargetCalendarId();
      const event = await createCalendarEvent({
        accessToken: googleToken.accessToken,
        summary: msg.summary,
        description: msg.description,
        date: msg.date,
        calendarId,
      });
      await persistentConfigMod.setInvoiceCalendarEvent(msg.ksefNumber, {
        eventId: event.id,
        htmlLink: event.htmlLink,
        calendarId,
        addedAt: new Date().toISOString(),
      });
      return { ok: true, data: event };
    }

    case "calendar.enabled.get": {
      const enabled = await persistentConfigMod.getCalendarEnabled();
      return { ok: true, data: enabled };
    }

    case "calendar.enabled.set": {
      await persistentConfigMod.setCalendarEnabled(msg.enabled);
      return { ok: true, data: null };
    }

    case "sheets.enabled.get": {
      const enabled = await persistentConfigMod.getSheetsEnabled();
      return { ok: true, data: enabled };
    }

    case "sheets.enabled.set": {
      await persistentConfigMod.setSheetsEnabled(msg.enabled);
      return { ok: true, data: null };
    }

    case "sheets.syncOutgoing.get": {
      const enabled = await persistentConfigMod.getSheetsSyncOutgoing();
      return { ok: true, data: enabled };
    }

    case "sheets.syncOutgoing.set": {
      await persistentConfigMod.setSheetsSyncOutgoing(msg.enabled);
      return { ok: true, data: null };
    }

    case "sheets.syncIncoming.get": {
      const enabled = await persistentConfigMod.getSheetsSyncIncoming();
      return { ok: true, data: enabled };
    }

    case "sheets.syncIncoming.set": {
      await persistentConfigMod.setSheetsSyncIncoming(msg.enabled);
      return { ok: true, data: null };
    }

    case "calendar.getEventForInvoice": {
      const event = await persistentConfigMod.getInvoiceCalendarEvent(msg.ksefNumber);
      return { ok: true, data: event };
    }

    case "calendar.getAllEvents": {
      const all = await persistentConfigMod.getInvoiceCalendarEvents();
      return { ok: true, data: all };
    }

    case "calendar.list": {
      const googleToken = await getStoredToken();
      if (!googleToken) {
        return { ok: false, error: "Not connected to Google" };
      }
      const { listCalendars } = await import("../google/calendar");
      const calendars = await listCalendars(googleToken.accessToken);
      return { ok: true, data: calendars };
    }

    case "calendar.getTarget": {
      const id = await persistentConfigMod.getTargetCalendarId();
      return { ok: true, data: id };
    }

    case "calendar.setTarget": {
      await persistentConfigMod.setTargetCalendarId(msg.calendarId);
      return { ok: true, data: null };
    }

    case "logs.get": {
      const { getLogBuffer } = await import("../shared/logger");
      return { ok: true, data: getLogBuffer() };
    }

    case "logs.clear": {
      const { clearLogBuffer } = await import("../shared/logger");
      clearLogBuffer();
      return { ok: true, data: null };
    }

    case "fetchOnResume.get": {
      const enabled = await persistentConfigMod.getFetchOnResume();
      return { ok: true, data: enabled };
    }

    case "fetchOnResume.set": {
      await persistentConfigMod.setFetchOnResume(msg.enabled);
      return { ok: true, data: null };
    }

    case "invoice.fetchXml": {
      if (!vaultMod.isUnlocked()) {
        return { ok: false, error: "Vault is locked" };
      }
      const ksefToken = await vaultMod.getKsefToken();
      const contextNip = await vaultMod.getContextNip();
      if (!ksefToken || !contextNip) {
        return { ok: false, error: "Missing KSeF token or NIP" };
      }
      const ksefOverride = (
        globalThis as unknown as { __ksefApiBaseUrlOverride?: string }
      ).__ksefApiBaseUrlOverride;
      const ksefEnv = await persistentConfigMod.getKsefEnvironment();
      const apiBase = ksefOverride ?? persistentConfigMod.getKsefApiBaseUrl(ksefEnv);

      const { authenticateWithKsefToken, terminateKsefSession } = await import("../ksef/auth");
      const { fetchInvoiceContent } = await import("../ksef/client");

      const session = await authenticateWithKsefToken({
        apiBaseUrl: apiBase,
        ksefToken,
        contextIdentifier: { type: "Nip", value: contextNip },
      });
      try {
        const xml = await fetchInvoiceContent({
          apiBaseUrl: apiBase,
          accessToken: session.accessToken.token,
          ksefNumber: msg.ksefNumber,
        });
        return { ok: true, data: xml };
      } finally {
        void terminateKsefSession({
          apiBaseUrl: apiBase,
          accessToken: session.accessToken.token,
        }).catch(() => {});
      }
    }

    // --- Options / reset (M3 sub-turn 6) ---------------------------------
    case "config.destroyAll": {
      await persistentConfigMod.destroyAll();
      await ensureAlarmMatchesConfig(); // clear alarm if autoSync was on
      return { ok: true, data: null };
    }

    case "sheets.clearTracking": {
      const target = await persistentConfigMod.getTargetSpreadsheet();
      if (target) {
        await persistentConfigMod.clearTrackedKsefNumbers(target.id);
      }
      return { ok: true, data: null };
    }

    // --- Notifications config ---------------------------------------------
    case "notifications.getConfig": {
      const ncfg = await persistentConfigMod.getNotificationConfig();
      return { ok: true, data: ncfg };
    }

    case "notifications.setConfig": {
      await persistentConfigMod.setNotificationConfig(msg.config);
      return { ok: true, data: null };
    }

    // --- KSeF environment ---------------------------------------------------
    case "ksef.getEnvironment": {
      const env = await persistentConfigMod.getKsefEnvironment();
      return {
        ok: true,
        data: {
          env,
          ...persistentConfigMod.KSEF_ENVIRONMENTS[env],
        },
      };
    }

    case "ksef.setEnvironment": {
      await persistentConfigMod.setKsefEnvironment(msg.env);
      return { ok: true, data: null };
    }

    case "dashboard.getStats": {
      const stats = await persistentConfigMod.getLastSyncStats();
      return { ok: true, data: stats };
    }

    case "sheets.getUrl": {
      const sheetUrl = await persistentConfigMod.getTargetSheetUrl();
      return { ok: true, data: sheetUrl };
    }

    case "incoming.getRecent": {
      const feed = await persistentConfigMod.getIncomingFeed();
      const lastRead = await persistentConfigMod.getIncomingLastReadAt();
      const items = feed.map((item) => ({
        ...item,
        isNew: !lastRead || item.syncedAt > lastRead,
      }));
      return { ok: true, data: items };
    }

    case "incoming.markRead": {
      await persistentConfigMod.markIncomingAsRead();
      // Clear the unread badge
      void autoSyncMod.setUnreadBadge(0);
      return { ok: true, data: null };
    }

    case "incoming.remove": {
      await persistentConfigMod.removeFromIncomingFeed(msg.ksefNumber);
      return { ok: true, data: null };
    }

    case "incoming.clearAll": {
      await persistentConfigMod.clearIncomingFeed();
      return { ok: true, data: null };
    }

    // --- KSeF sync -------------------------------------------------------
    case "sync.run": {
      const ksefOverride = (
        globalThis as unknown as { __ksefApiBaseUrlOverride?: string }
      ).__ksefApiBaseUrlOverride;
      const sheetsOverride = (
        globalThis as unknown as { __sheetsApiBaseUrlOverride?: string }
      ).__sheetsApiBaseUrlOverride;

      // Read the Google access token if the user has connected — runSync
      // will skip the Sheets branch entirely if this is undefined, so
      // M1's behaviour (count only, no sheet write) is the default for
      // users who haven't clicked "Connect Google" yet. Also skip when
      // the Sheets feature is turned off in config.
      const googleToken = await getStoredToken();
      const sheetsEnabled = await persistentConfigMod.getSheetsEnabled();
      const sheetsSyncOutgoing = await persistentConfigMod.getSheetsSyncOutgoing();
      const sheetsSyncIncoming = await persistentConfigMod.getSheetsSyncIncoming();

      const ksefEnv = await persistentConfigMod.getKsefEnvironment();
      const ksefBaseUrl = persistentConfigMod.getKsefApiBaseUrl(ksefEnv);

      const isFirstSync = (await persistentConfigMod.getLastSyncStats()) === null;

      const result = await runSync({
        apiBaseUrl: msg.apiBaseUrl ?? ksefOverride ?? ksefBaseUrl,
        sheetsApiBaseUrl: sheetsOverride ?? SHEETS_API_BASE_URL,
        googleAccessToken: sheetsEnabled ? googleToken?.accessToken : undefined,
        sheetsSyncOutgoing,
        sheetsSyncIncoming,
        fromDate: msg.fromDate,
        toDate: msg.toDate,
      });
      // Project to the SyncResult shape declared in shared/messages
      // (drops the `sample` field — popup doesn't render it yet).
      const data: SyncResult = {
        totalCount: result.totalCount,
        durationMs: result.durationMs,
        syncedAt: result.syncedAt,
        fromDate: result.fromDate,
        toDate: result.toDate,
        spreadsheetId: result.spreadsheetId,
        spreadsheetUrl: result.spreadsheetUrl,
        appendedRows: result.appendedRows,
        createdSpreadsheet: result.createdSpreadsheet,
        incomingTotal: result.incomingTotal,
        newIncomingCount: result.newIncomingCount,
      };
      // Persist stats for the popup dashboard. On the first-ever sync we
      // intentionally store newIncoming=0 + appendedRows=0 so the popup
      // doesn't display a misleading "+45 new" delta for historical data
      // that's just being backfilled — consistent with the no-notifications +
      // mark-all-read first-sync behavior.
      void persistentConfigMod.setLastSyncStats({
        syncedAt: result.syncedAt,
        totalOutgoing: result.totalCount,
        totalIncoming: result.incomingTotal ?? 0,
        appendedRows: isFirstSync ? 0 : result.appendedRows ?? 0,
        newIncoming: isFirstSync ? 0 : result.newIncomingCount ?? 0,
      });
      const appended = result.appendedRows ?? 0;
      if (isFirstSync) {
        // First-ever sync: user is just getting historical data loaded.
        // Skip notifications and pre-mark incoming feed as read so no
        // unread badge spams them on initial setup.
        void persistentConfigMod.markIncomingAsRead();
      } else {
        // Fire notifications (each checks its own toggle).
        void notifySyncResult({ totalCount: result.totalCount, appendedRows: appended });
        if (appended > 0) void notifyNewInvoices({ newCount: appended });
        if ((result.newIncomingCount ?? 0) > 0) {
          void notifyIncomingInvoices({ newCount: result.newIncomingCount! });
        }
      }
      return { ok: true, data };
    }
  }
}

log("info", "Service worker loaded");
