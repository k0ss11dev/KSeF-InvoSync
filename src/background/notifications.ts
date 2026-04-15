// SPDX-License-Identifier: GPL-3.0-or-later
// Chrome notifications for KSeF → Sheets Bridge. Each notification type
// is guarded by a per-type toggle in persistent-config. All methods are
// fire-and-forget — failures are logged but never bubble up.

import { t } from "../shared/i18n";
import { log } from "../shared/logger";
import * as persistentConfig from "../storage/persistent-config";

/**
 * Show "Synced N invoices, M new rows" after a successful sync.
 */
export async function notifySyncResult(opts: {
  totalCount: number;
  appendedRows: number;
}): Promise<void> {
  const cfg = await persistentConfig.getNotificationConfig();
  if (!cfg.syncResult) return;
  try {
    await chrome.notifications.create(`sync-result-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png") ?? "",
      title: t("app_title"),
      message: t("notif_sync_result", String(opts.totalCount), String(opts.appendedRows)),
    });
  } catch (err) {
    log("warn", "notifySyncResult failed:", err);
  }
}

/**
 * Show "N new invoices found" when dedup detects new rows to append.
 */
export async function notifyNewInvoices(opts: {
  newCount: number;
}): Promise<void> {
  if (opts.newCount === 0) return;
  const cfg = await persistentConfig.getNotificationConfig();
  if (!cfg.newInvoices) return;
  try {
    await chrome.notifications.create(`new-invoices-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png") ?? "",
      title: t("app_title"),
      message: t("notif_new_invoices", String(opts.newCount)),
    });
  } catch (err) {
    log("warn", "notifyNewInvoices failed:", err);
  }
}

/**
 * Show an error notification when auto-sync fails.
 */
export async function notifySyncError(opts: {
  error: string;
}): Promise<void> {
  const cfg = await persistentConfig.getNotificationConfig();
  if (!cfg.syncError) return;
  try {
    await chrome.notifications.create(`sync-error-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png") ?? "",
      title: t("app_title"),
      message: t("notif_sync_error", opts.error),
    });
  } catch (err) {
    log("warn", "notifySyncError failed:", err);
  }
}

/**
 * Show "N new incoming invoices from suppliers" when Subject2 query
 * detects new buyer-side invoices. (Requires incoming invoice checking
 * to be wired in — future sub-turn.)
 */
export async function notifyIncomingInvoices(opts: {
  newCount: number;
}): Promise<void> {
  if (opts.newCount === 0) return;
  const cfg = await persistentConfig.getNotificationConfig();
  if (!cfg.incomingInvoices) return;
  try {
    await chrome.notifications.create(`incoming-invoices-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png") ?? "",
      title: t("app_title"),
      message: t("notif_incoming_invoices", String(opts.newCount)),
    });
  } catch (err) {
    log("warn", "notifyIncomingInvoices failed:", err);
  }
}
