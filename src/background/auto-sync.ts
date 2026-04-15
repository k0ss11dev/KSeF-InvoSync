// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-sync (M3 sub-turn 4): opt-in periodic background sync using
// chrome.alarms. The user toggles it from the popup; the toggle is stored
// in persistent-config (chrome.storage.local) and defaults to OFF.
//
// Wiring summary:
//   - chrome.runtime.onStartup        → ensureAlarmMatchesConfig()
//                                        (browser restart path)
//   - chrome.alarms.onAlarm           → runBackgroundSyncIfReady()
//                                        (fired every period while enabled)
//   - autoSync.setEnabled message     → ensureAlarmMatchesConfig()
//                                        (toggle path — see service-worker.ts)
//
// The background sync is deliberately conservative: if the vault is locked
// or Google isn't connected, it is a silent no-op. Both are the normal
// state after a browser restart (vault keys live in SW memory and clear on
// SW suspension), so "enabled" really means "sync when you can, skip when
// you can't". No notifications yet — that's a later sub-turn.

import { getStoredToken } from "../google/auth";
import { runSync } from "../ksef/sync";
import { log } from "../shared/logger";
import * as persistentConfig from "../storage/persistent-config";
import * as vault from "../storage/vault";
import {
  notifyIncomingInvoices,
  notifyNewInvoices,
  notifySyncError,
  notifySyncResult,
} from "./notifications";

/**
 * Name of the chrome.alarms entry. There's only one, shared across the
 * whole extension; we create/clear it to match the user's toggle.
 */
export const AUTO_SYNC_ALARM_NAME = "invo-sync.autoSync";

// Period is now configurable via persistent-config.getAutoSyncInterval().
// Kept as a re-export for backward compat with the SW message handler.

/**
 * Create or clear the auto-sync alarm so its presence matches the stored
 * config flag. Idempotent — safe to call on every SW wake, on popup toggle,
 * on runtime.onStartup, etc. Tests call it directly via a bridge.
 *
 * We always clear-then-create when enabling to avoid Chrome's "alarm with
 * the same name already exists, silently replaced" behaviour leaking a
 * stale period if the constant ever changes.
 */
export async function ensureAlarmMatchesConfig(): Promise<void> {
  const enabled = await persistentConfig.getAutoSyncEnabled();
  if (enabled) {
    // chrome.alarms.create replaces any existing alarm with the same name,
    // so there's no need to clear first — but being explicit makes the
    // intent obvious in logs and tests.
    const intervalMin = await persistentConfig.getAutoSyncInterval();
    await chrome.alarms.clear(AUTO_SYNC_ALARM_NAME);
    await chrome.alarms.create(AUTO_SYNC_ALARM_NAME, {
      periodInMinutes: intervalMin,
    });
    log("info", `Auto-sync alarm registered (${intervalMin} min period)`);
  } else {
    await chrome.alarms.clear(AUTO_SYNC_ALARM_NAME);
    log("info", "Auto-sync alarm cleared");
  }
}

/**
 * Background sync: runs the full KSeF → Sheets pipeline, but silently skips
 * if preconditions aren't met. Exported so the onAlarm listener and the
 * tests can call it directly.
 *
 * Preconditions for a real sync:
 *   1. autoSync is still enabled (defence-in-depth — the alarm should
 *      have been cleared when the user disabled it, but check anyway)
 *   2. vault is unlocked (we need the KSeF token)
 *   3. a Google access token exists (we have somewhere to write)
 *
 * Any failure inside runSync() is caught and logged as a warning — we do
 * NOT want a failed background sync to blow up the service worker or bubble
 * a notification to the user (no notifications at all yet).
 */
export async function runBackgroundSyncIfReady(opts?: {
  /** Production defaults — overridable so tests can point at mocks. */
  ksefApiBaseUrl?: string;
  sheetsApiBaseUrl?: string;
}): Promise<
  | { ran: true; appendedRows: number; totalCount: number }
  | { ran: false; reason: "disabled" | "vault-locked" | "no-google-token" | "error"; error?: string }
> {
  if (!(await persistentConfig.getAutoSyncEnabled())) {
    return { ran: false, reason: "disabled" };
  }
  if (!vault.isUnlocked()) {
    log("info", "Auto-sync skipped: vault is locked");
    void updateBadge("locked");
    return { ran: false, reason: "vault-locked" };
  }
  const googleToken = await getStoredToken();
  if (!googleToken) {
    log("info", "Auto-sync skipped: Google not connected");
    void updateBadge("no-google");
    return { ran: false, reason: "no-google-token" };
  }

  try {
    const isFirstSync = (await persistentConfig.getLastSyncStats()) === null;
    const sheetsEnabled = await persistentConfig.getSheetsEnabled();
    const sheetsSyncOutgoing = await persistentConfig.getSheetsSyncOutgoing();
    const sheetsSyncIncoming = await persistentConfig.getSheetsSyncIncoming();
    const result = await runSync({
      apiBaseUrl: opts?.ksefApiBaseUrl ?? resolveKsefBaseUrl(),
      sheetsApiBaseUrl: opts?.sheetsApiBaseUrl ?? resolveSheetsBaseUrl(),
      googleAccessToken: sheetsEnabled ? googleToken.accessToken : undefined,
      sheetsSyncOutgoing,
      sheetsSyncIncoming,
    });
    const appended = result.appendedRows ?? 0;
    log(
      "info",
      `Auto-sync done: ${result.totalCount} query / ${appended} new rows`,
    );

    // Persist stats for the popup dashboard. On first sync we zero the
    // delta fields so the popup doesn't show a misleading "+N new" badge
    // for historical backfill — same rationale as the manual sync path.
    void persistentConfig.setLastSyncStats({
      syncedAt: result.syncedAt,
      totalOutgoing: result.totalCount,
      totalIncoming: result.incomingTotal ?? 0,
      appendedRows: isFirstSync ? 0 : appended,
      newIncoming: isFirstSync ? 0 : result.newIncomingCount ?? 0,
    });

    // Update badge: show unread count if new incoming, else clear.
    // First sync: pre-mark all as read so no unread badge on initial setup.
    const newIncoming = result.newIncomingCount ?? 0;
    if (isFirstSync) {
      await persistentConfig.markIncomingAsRead();
      void updateBadge("ok");
    } else if (newIncoming > 0) {
      const feed = await persistentConfig.getIncomingFeed();
      const lastRead = await persistentConfig.getIncomingLastReadAt();
      const unreadTotal = feed.filter((i) => !lastRead || i.syncedAt > lastRead).length;
      void setUnreadBadge(unreadTotal);
    } else {
      void updateBadge("ok");
    }

    // Fire notifications (each one checks its own toggle internally).
    // Skip entirely on first sync — user is just getting historical data.
    if (!isFirstSync) {
      void notifySyncResult({ totalCount: result.totalCount, appendedRows: appended });
      if (appended > 0) {
        void notifyNewInvoices({ newCount: appended });
      }
      if ((result.newIncomingCount ?? 0) > 0) {
        void notifyIncomingInvoices({ newCount: result.newIncomingCount! });
      }
    }

    return {
      ran: true,
      appendedRows: appended,
      totalCount: result.totalCount,
    };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log("warn", "Auto-sync failed (non-fatal):", message);
    void updateBadge("error");
    void notifySyncError({ error: message });
    return { ran: false, reason: "error", error: message };
  }
}

/**
 * Catch-up sync: run `runBackgroundSyncIfReady` IF the last successful sync
 * is older than the configured auto-sync interval. Called from:
 *   - chrome.runtime.onStartup (browser start after being closed)
 *   - chrome.idle.onStateChanged -> "active" (wake from system sleep / unlock)
 *
 * Skips silently when:
 *   - fetchOnResume is OFF
 *   - last sync is fresh (delta < interval)
 *   - normal preconditions fail (vault locked, no google, etc.)
 */
export async function catchUpSyncIfStale(
  reason: "startup" | "idle-wake",
): Promise<void> {
  const enabled = await persistentConfig.getFetchOnResume();
  if (!enabled) {
    log("info", `Catch-up (${reason}) skipped: fetchOnResume is off`);
    return;
  }
  const stats = await persistentConfig.getLastSyncStats();
  const intervalMin = await persistentConfig.getAutoSyncInterval();
  const intervalMs = intervalMin * 60_000;
  if (stats?.syncedAt) {
    const delta = Date.now() - new Date(stats.syncedAt).getTime();
    if (delta < intervalMs) {
      log(
        "info",
        `Catch-up (${reason}) skipped: last sync ${Math.round(delta / 60_000)}min ago, interval=${intervalMin}min`,
      );
      return;
    }
    log(
      "info",
      `Catch-up (${reason}) triggering: ${Math.round(delta / 60_000)}min since last sync (threshold=${intervalMin}min)`,
    );
  } else {
    log("info", `Catch-up (${reason}) triggering: no prior sync on record`);
  }
  const res = await runBackgroundSyncIfReady();
  log("info", `Catch-up (${reason}) result:`, JSON.stringify(res));
}

// Production base URLs resolved at call time — tests set these overrides via
// globalThis before firing the alarm, and we want the latest value, not one
// captured at module load.
function resolveKsefBaseUrl(): string {
  const override = (
    globalThis as unknown as { __ksefApiBaseUrlOverride?: string }
  ).__ksefApiBaseUrlOverride;
  return override ?? "https://api-test.ksef.mf.gov.pl/v2";
}

function resolveSheetsBaseUrl(): string {
  const override = (
    globalThis as unknown as { __sheetsApiBaseUrlOverride?: string }
  ).__sheetsApiBaseUrlOverride;
  return override ?? "https://sheets.googleapis.com";
}

// --- Extension icon badge --------------------------------------------------
// Visual indicator on the extension icon so the user can see at a glance
// whether auto-sync is running, blocked, or failing.

type BadgeState = "ok" | "locked" | "no-google" | "error";

// Base icon image data — loaded once, cached.
let baseIconData: ImageData | null = null;

async function loadBaseIcon(): Promise<ImageData> {
  if (baseIconData) return baseIconData;
  const response = await fetch(chrome.runtime.getURL("icons/icon-32.png"));
  const blob = await response.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, 32, 32);
  baseIconData = ctx.getImageData(0, 0, 32, 32);
  return baseIconData;
}

async function setIconWithDot(color: string): Promise<void> {
  try {
    const base = await loadBaseIcon();
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(base, 0, 0);
    // Draw 7px dot in bottom-right corner
    ctx.beginPath();
    ctx.arc(26, 26, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // White border for visibility
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    const imageData = ctx.getImageData(0, 0, 32, 32);
    await chrome.action.setIcon({ imageData: { "32": imageData } });
  } catch {
    // Fallback: just use badge
    await chrome.action.setBadgeText({ text: "·" });
    await chrome.action.setBadgeBackgroundColor({ color });
  }
}

async function clearIconDot(): Promise<void> {
  try {
    // Reset to the default icon from manifest
    await chrome.action.setIcon({ path: { "32": "icons/icon-32.png" } });
  } catch {
    await chrome.action.setBadgeText({ text: "" });
  }
}

/**
 * Set the unread-invoice count as a badge text on the extension icon.
 * Called after sync completes with new incoming invoices, and cleared
 * when the user opens the popup (marks-as-read).
 */
export async function setUnreadBadge(count: number): Promise<void> {
  try {
    if (count > 0) {
      await chrome.action.setBadgeText({ text: String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" }); // blue
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // non-fatal
  }
}

export async function updateBadge(state: BadgeState): Promise<void> {
  try {
    // Clear badge text — we use icon overlay instead
    await chrome.action.setBadgeText({ text: "" });
    // Draw a small colored dot on the icon via OffscreenCanvas
    const color = state === "ok" ? "#22c55e"
      : state === "locked" ? "#ef4444"
      : state === "no-google" ? "#f59e0b"
      : "#ef4444";
    await setIconWithDot(color);
  } catch {
    // Non-fatal
  }
}
