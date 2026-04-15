// SPDX-License-Identifier: GPL-3.0-or-later
// KSeF section of the popup. Self-contained state machine that walks the
// user through:
//   uninitialized → vault setup form
//   locked        → unlock form
//   ready         → sync button + last result
//
// Communicates with the service worker exclusively via the message router
// in shared/messages.ts. No direct imports from src/storage or src/ksef —
// keeps the popup bundle small and the IPC contract explicit.

import { type FormEvent, useEffect, useState } from "react";
import { classifyError } from "../shared/errors";
import { t } from "../shared/i18n";
import type { LastSyncStats } from "../storage/persistent-config";
import type {
  AutoSyncConfig,
  Message,
  Response,
  SpreadsheetSummary,
  SyncResult,
  TargetSpreadsheet,
  VaultStatus,
} from "../shared/messages";

// --- IPC helper -----------------------------------------------------------

function send<T = unknown>(msg: Message): Promise<Response<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res: Response<T> | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message ?? "Unknown runtime error",
        });
        return;
      }
      if (!res) {
        resolve({ ok: false, error: "Empty response from service worker" });
        return;
      }
      resolve(res);
    });
  });
}

// --- State machine --------------------------------------------------------

type SectionState =
  | { kind: "loading" }
  | { kind: "uninitialized" }
  | { kind: "locked" }
  | { kind: "ready"; lastSync: SyncResult | null }
  | { kind: "syncing"; previousLastSync: SyncResult | null }
  | { kind: "error"; message: string; previous: SectionState };

export function KsefSection() {
  const [state, setState] = useState<SectionState>({ kind: "loading" });

  const refresh = async () => {
    const res = await send<VaultStatus>({ type: "vault.status" });
    if (!res.ok) {
      setState((prev) => ({ kind: "error", message: res.error, previous: prev }));
      return;
    }
    const status = res.data;
    if (!status.initialized) {
      setState({ kind: "uninitialized" });
      return;
    }
    if (!status.unlocked) {
      setState({ kind: "locked" });
      return;
    }
    if (!status.hasKsefToken || !status.hasContextNip) {
      // Vault is unlocked but missing required entries — treat as
      // uninitialized for the UX so the user can fill them in.
      setState({ kind: "uninitialized" });
      return;
    }
    setState({ kind: "ready", lastSync: null });
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSync = async () => {
    setState((prev) =>
      prev.kind === "ready"
        ? { kind: "syncing", previousLastSync: prev.lastSync }
        : prev,
    );
    const res = await send<SyncResult>({ type: "sync.run" });
    if (!res.ok) {
      setState((prev) => ({
        kind: "error",
        message: res.error,
        previous:
          prev.kind === "syncing"
            ? { kind: "ready", lastSync: prev.previousLastSync }
            : prev,
      }));
      return;
    }
    setState({ kind: "ready", lastSync: res.data });
  };

  return (
    <section className="ksef-section" aria-label={t("section_ksef")}>
      <h2>{t("section_ksef")}</h2>

      {state.kind === "loading" && <p className="muted small">{t("status_loading")}</p>}

      {state.kind === "uninitialized" && (
        <SetupForm onComplete={() => void refresh()} />
      )}

      {state.kind === "locked" && (
        <UnlockForm onComplete={() => void refresh()} />
      )}

      {state.kind === "ready" && (
        <SyncReady lastSync={state.lastSync} onStart={handleSync} />
      )}

      {state.kind === "syncing" && (
        <p className="muted small">{t("status_syncing")}</p>
      )}

      {state.kind === "error" && (
        <ErrorDisplay
          message={state.message}
          onDismiss={() => setState(state.previous)}
        />
      )}
    </section>
  );
}

// --- Classified error display (M3 sub-turn 7) ----------------------------

function ErrorDisplay({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const classified = classifyError(message);
  return (
    <div className="form error-display">
      <p className="small">{classified.hint}</p>
      <details className="error-details">
        <summary className="muted small">{t("error_details")}</summary>
        <p className="error small">{classified.raw}</p>
      </details>
      <button type="button" onClick={onDismiss}>
        {t("button_dismiss")}
      </button>
    </div>
  );
}

// --- Sub-components -------------------------------------------------------

const DRAFT_KEY = "popup.setupDraft";

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [ksefToken, setKsefToken] = useState("");
  const [contextNip, setContextNip] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore draft from session storage on mount (survives popup close).
  useEffect(() => {
    void chrome.storage.session.get(DRAFT_KEY).then((r) => {
      const d = r[DRAFT_KEY] as { p?: string; t?: string; n?: string } | undefined;
      if (d) {
        if (d.p) setPassphrase(d.p);
        if (d.t) setKsefToken(d.t);
        if (d.n) setContextNip(d.n);
      }
    });
  }, []);

  // Save draft on every change.
  useEffect(() => {
    void chrome.storage.session.set({
      [DRAFT_KEY]: { p: passphrase, t: ksefToken, n: contextNip },
    });
  }, [passphrase, ksefToken, contextNip]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || !ksefToken || !contextNip) return;
    setBusy(true);
    setError(null);
    const res = await send({
      type: "vault.create",
      passphrase,
      ksefToken,
      contextNip,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Clear draft on success.
    void chrome.storage.session.remove(DRAFT_KEY);
    onComplete();
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted small">{t("setup_description")}</p>
      <label>
        <span>{t("field_passphrase")}</span>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t("placeholder_passphrase")}
          required
          minLength={6}
        />
      </label>
      <label>
        <span>{t("field_ksef_token")}</span>
        <input
          type="password"
          value={ksefToken}
          onChange={(e) => {
            const val = e.target.value;
            setKsefToken(val);
            // Auto-extract NIP from token format: refNum|nip-NNNNNNNNNN|hex
            const nipMatch = val.match(/\|nip-(\d{10})\|/);
            if (nipMatch && !contextNip) {
              setContextNip(nipMatch[1]);
            }
          }}
          onPaste={(e) => {
            // Handle paste — extract NIP immediately from pasted content
            const pasted = e.clipboardData.getData("text");
            const nipMatch = pasted.match(/\|nip-(\d{10})\|/);
            if (nipMatch) {
              setContextNip(nipMatch[1]);
            }
          }}
          placeholder={t("placeholder_ksef_token")}
          required
        />
      </label>
      <label>
        <span>{t("field_nip")}</span>
        <input
          type="text"
          value={contextNip}
          onChange={(e) => setContextNip(e.target.value)}
          placeholder={t("placeholder_nip")}
          required
          pattern="\d{10}"
          inputMode="numeric"
        />
      </label>
      {error && <p className="error small">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? t("button_setup_busy") : t("button_setup")}
      </button>
      {contextNip && (
        <p className="muted small">{t("setup_nip_detected", contextNip)}</p>
      )}
    </form>
  );
}

function UnlockForm({ onComplete }: { onComplete: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    setError(null);
    const res = await send<{ unlocked: boolean }>({
      type: "vault.unlock",
      passphrase,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.data.unlocked) {
      setError(t("error_wrong_passphrase"));
      return;
    }
    onComplete();
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted small">{t("unlock_description")}</p>
      <label>
        <span>{t("field_passphrase")}</span>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder={t("placeholder_unlock")}
          required
          autoFocus
        />
      </label>
      {error && <p className="error small">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? t("button_unlock_busy") : t("button_unlock")}
      </button>
    </form>
  );
}

function SyncReady({
  lastSync,
  onStart,
}: {
  lastSync: SyncResult | null;
  onStart: () => void;
}) {
  return (
    <div className="form">
      {lastSync ? (
        <>
          <p className="ok small">
            {t("sync_result", String(lastSync.totalCount), (lastSync.durationMs / 1000).toFixed(1))}
          </p>
          {lastSync.spreadsheetUrl ? (
            <p className="small">
              {lastSync.createdSpreadsheet
                ? t("sync_created_sheet", String(lastSync.appendedRows ?? 0))
                : t("sync_appended_rows", String(lastSync.appendedRows ?? 0))}
              {" · "}
              <a
                href={lastSync.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("sync_open_sheets")}
              </a>
            </p>
          ) : (
            <p className="muted small">{t("sync_connect_google_hint")}</p>
          )}
          {(lastSync.newIncomingCount ?? 0) > 0 && (
            <p className="small">
              {t("sync_incoming_new", String(lastSync.newIncomingCount))}
            </p>
          )}
          {lastSync.incomingTotal != null && lastSync.newIncomingCount === 0 && (
            <p className="muted small">
              {t("sync_incoming_none")}
            </p>
          )}
        </>
      ) : (
        <p className="muted small">{t("sync_ready")}</p>
      )}

      <DashboardStats />

      <AutoSyncToggle />

      <SheetPicker />

      <ConnectionTest />

      <button type="button" className="primary" onClick={onStart}>
        {t("button_sync")}
      </button>
    </div>
  );
}

// --- Connection test -------------------------------------------------------

function ConnectionTest() {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "success"; count: number; hasMore: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const test = async () => {
    setState({ kind: "testing" });
    const res = await send<{ authenticated: boolean; invoiceCount: number; hasMore: boolean }>({
      type: "ksef.testConnection",
    });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({ kind: "success", count: res.data.invoiceCount, hasMore: res.data.hasMore });
  };

  return (
    <div className="connection-test">
      {state.kind === "idle" && (
        <button type="button" className="link-button small" onClick={test}>
          {t("button_test_connection")}
        </button>
      )}
      {state.kind === "testing" && (
        <p className="muted small">{t("button_test_busy")}</p>
      )}
      {state.kind === "success" && (
        <p className="ok small">
          {state.hasMore
            ? t("test_success_more", String(state.count))
            : t("test_success", String(state.count))}
        </p>
      )}
      {state.kind === "error" && (
        <p className="error small">{state.message}</p>
      )}
    </div>
  );
}

// --- Auto-sync toggle (M3 sub-turn 4) ------------------------------------

function AutoSyncToggle() {
  const [config, setConfig] = useState<AutoSyncConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await send<AutoSyncConfig>({ type: "autoSync.getConfig" });
      if (res.ok) setConfig(res.data);
    })();
  }, []);

  const onToggle = async (next: boolean) => {
    if (!config) return;
    // Optimistic update so the controlled checkbox reflects the new state
    // immediately — otherwise React re-renders it back to the old value
    // before the async IPC round-trip completes.
    setConfig({ ...config, enabled: next });
    setBusy(true);
    const res = await send({ type: "autoSync.setEnabled", enabled: next });
    setBusy(false);
    if (!res.ok) {
      // Revert on failure.
      setConfig({ ...config, enabled: !next });
    }
  };

  if (!config) {
    return <p className="muted small">{t("autosync_loading")}</p>;
  }

  return (
    <label className="auto-sync-row small">
      <span>
        {t("autosync_label", String(config.periodMinutes))}
      </span>
      <input
        type="checkbox"
        checked={config.enabled}
        disabled={busy}
        onChange={(e) => void onToggle(e.target.checked)}
      />
    </label>
  );
}

// --- Dashboard stats (quick-glance) ----------------------------------------

function DashboardStats() {
  const [stats, setStats] = useState<LastSyncStats | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await send<LastSyncStats | null>({ type: "dashboard.getStats" });
      if (res.ok && res.data) setStats(res.data);
    })();
  }, []);

  if (!stats) return null;

  const ago = formatTimeAgo(stats.syncedAt);

  return (
    <div className="dashboard-stats">
      <div className="stat-row">
        <span className="muted small">{t("dashboard_last_sync")}</span>
        <span className="small">{ago}</span>
      </div>
      <div className="stat-row">
        <span className="muted small">{t("dashboard_outgoing")}</span>
        <span className="small"><strong>{stats.totalOutgoing}</strong></span>
      </div>
      <div className="stat-row">
        <span className="muted small">{t("dashboard_incoming")}</span>
        <span className="small"><strong>{stats.totalIncoming}</strong></span>
      </div>
    </div>
  );
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("dashboard_just_now");
  if (minutes < 60) return t("dashboard_minutes_ago", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("dashboard_hours_ago", String(hours));
  const days = Math.floor(hours / 24);
  return t("dashboard_days_ago", String(days));
}

// --- Sheet picker (M3 sub-turn 2) -----------------------------------------

type PickerState =
  | { kind: "loading" }
  | { kind: "closed"; target: TargetSpreadsheet | null }
  | { kind: "open"; target: TargetSpreadsheet | null; sheets: SpreadsheetSummary[] }
  | { kind: "open-loading"; target: TargetSpreadsheet | null }
  | { kind: "error"; message: string };

function SheetPicker() {
  const [state, setState] = useState<PickerState>({ kind: "loading" });

  // Initial: load the current target from persistent-config so the popup
  // knows what's selected even before the user clicks anything.
  useEffect(() => {
    void (async () => {
      const res = await send<TargetSpreadsheet | null>({ type: "sheets.getTarget" });
      if (!res.ok) {
        setState({ kind: "error", message: res.error });
        return;
      }
      setState({ kind: "closed", target: res.data });
    })();
  }, []);

  const openPicker = async () => {
    const previous =
      state.kind === "closed" || state.kind === "open" || state.kind === "open-loading"
        ? state.target
        : null;
    setState({ kind: "open-loading", target: previous });
    const res = await send<SpreadsheetSummary[]>({ type: "sheets.list" });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({ kind: "open", target: previous, sheets: res.data });
  };

  const cancelPicker = () => {
    if (state.kind === "open" || state.kind === "open-loading") {
      setState({ kind: "closed", target: state.target });
    }
  };

  const selectExisting = async (sheet: SpreadsheetSummary) => {
    const res = await send({
      type: "sheets.setTarget",
      id: sheet.id,
      name: sheet.name,
    });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({
      kind: "closed",
      target: { id: sheet.id, name: sheet.name },
    });
  };

  const selectCreateNew = async () => {
    // "Create new" means: clear the current target so the next sync auto-creates
    // a fresh sheet. The actual creation happens inside runSync().
    const res = await send({ type: "sheets.clearTarget" });
    if (!res.ok) {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({ kind: "closed", target: null });
  };

  if (state.kind === "loading") {
    return <p className="muted small">{t("picker_loading")}</p>;
  }

  if (state.kind === "error") {
    return (
      <div className="picker">
        <p className="error small">{state.message}</p>
        <button
          type="button"
          onClick={() => setState({ kind: "closed", target: null })}
        >
          {t("button_dismiss")}
        </button>
      </div>
    );
  }

  if (state.kind === "closed") {
    return (
      <div className="picker-summary">
        {state.target ? (
          <p className="small">
            <span className="muted">{t("picker_target")}</span>{" "}
            <strong>{state.target.name}</strong>{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void openPicker()}
            >
              {t("picker_change")}
            </button>
          </p>
        ) : (
          <p className="muted small">
            {t("picker_no_target")}{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => void openPicker()}
            >
              {t("picker_pick_existing")}
            </button>
          </p>
        )}
      </div>
    );
  }

  // open or open-loading
  return (
    <div className="picker">
      <p className="small">
        <strong>{t("picker_title")}</strong>
      </p>
      {state.kind === "open-loading" ? (
        <p className="muted small">{t("picker_loading_sheets")}</p>
      ) : (
        <ul className="picker-list">
          {state.sheets.length === 0 && (
            <li className="muted small">{t("picker_no_sheets")}</li>
          )}
          {state.sheets.map((sheet) => {
            const isCurrent = state.target?.id === sheet.id;
            return (
              <li key={sheet.id}>
                <button
                  type="button"
                  className={`picker-item ${isCurrent ? "current" : ""}`}
                  onClick={() => void selectExisting(sheet)}
                >
                  {isCurrent ? "● " : "○ "}
                  {sheet.name}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="picker-item picker-create-new"
              onClick={() => void selectCreateNew()}
            >
              {t("picker_create_new")}
            </button>
          </li>
        </ul>
      )}
      <div className="picker-actions">
        <button type="button" onClick={cancelPicker}>
          {t("button_cancel")}
        </button>
      </div>
    </div>
  );
}
