// SPDX-License-Identifier: GPL-3.0-or-later
// Full-page settings for KSeF → Sheets Bridge. Opens in a tab via
// chrome://extensions → "Options" or from the popup's Settings link.
//
// Surfaces:
//   - Google connection status + Disconnect
//   - Auto-sync toggle
//   - Clear sheet tracking (re-sync from scratch)
//   - Lock / destroy vault
//   - Reset all settings

import { useEffect, useState } from "react";
import { type Locale, getActiveLocale, setLocale, t } from "../shared/i18n";
import type { KsefEnvironment, NotificationConfig } from "../storage/persistent-config";
import { KSEF_ENVIRONMENTS } from "../storage/persistent-config";
import type {
  AuthStatus,
  AutoSyncConfig,
  Message,
  Response,
  TargetSpreadsheet,
  VaultStatus,
} from "../shared/messages";

import MuiButton from "@mui/material/Button";
import MuiCheckbox from "@mui/material/Checkbox";
import MuiCard from "@mui/material/Card";
import MuiCardContent from "@mui/material/CardContent";
import MuiFormControlLabel from "@mui/material/FormControlLabel";
import MuiFormControl from "@mui/material/FormControl";
import MuiFormGroup from "@mui/material/FormGroup";
import MuiInputLabel from "@mui/material/InputLabel";
import MuiSelect from "@mui/material/Select";
import MuiMenuItem from "@mui/material/MenuItem";
import MuiStack from "@mui/material/Stack";
import MuiTypography from "@mui/material/Typography";
import MuiAlert from "@mui/material/Alert";
import MuiIconButton from "@mui/material/IconButton";
import MuiChip from "@mui/material/Chip";
import MuiContainer from "@mui/material/Container";
import MuiRadio from "@mui/material/Radio";
import MuiRadioGroup from "@mui/material/RadioGroup";
import MuiSwitch from "@mui/material/Switch";
import MuiPaper from "@mui/material/Paper";

// --- IPC helper (same pattern as popup) -----------------------------------

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

// --- Options root ---------------------------------------------------------

export function Options() {
  return (
    <MuiContainer maxWidth="sm" sx={{ py: 3 }}>
      <MuiStack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <MuiTypography variant="h4" sx={{ fontWeight: 700, flex: 1 }}>{t("app_title")}</MuiTypography>
        <MuiChip size="small" color="warning" label={t("env_badge_settings")} />
      </MuiStack>
      <MuiStack spacing={2}>
        <LanguageSection />
        <KsefEnvSection />
        <GoogleSection />
        <SyncSection />
        <NotificationsSection />
        <VaultSection />
        <LogsSection />
        <DangerZone />
      </MuiStack>
      <MuiTypography variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "center", mt: 3 }}>
        {t("footer_license")}
      </MuiTypography>
    </MuiContainer>
  );
}

// --- Language selector -----------------------------------------------------

function LanguageSection() {
  const [locale, setLocaleState] = useState<Locale>(getActiveLocale());

  const onChange = async (next: Locale) => {
    setLocaleState(next);
    await setLocale(next);
    // Reload the page to re-render all strings in the new locale.
    window.location.reload();
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("options_language")}</MuiTypography>
        <MuiRadioGroup
          value={locale}
          onChange={(e) => void onChange(e.target.value as Locale)}
        >
          <MuiFormControlLabel value="en" control={<MuiRadio size="small" />} label="English" />
          <MuiFormControlLabel value="pl" control={<MuiRadio size="small" />} label="Polski" />
        </MuiRadioGroup>
      </MuiCardContent>
    </MuiCard>
  );
}

// --- KSeF environment -----------------------------------------------------

function KsefEnvSection() {
  const [env, setEnv] = useState<KsefEnvironment | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await send<{ env: KsefEnvironment }>({ type: "ksef.getEnvironment" });
      if (res.ok) setEnv(res.data.env);
    })();
  }, []);

  const onChange = async (next: KsefEnvironment) => {
    setEnv(next);
    await send({ type: "ksef.setEnvironment", env: next });
  };

  const envKeys = Object.keys(KSEF_ENVIRONMENTS) as KsefEnvironment[];

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("options_ksef_env")}</MuiTypography>
        {!env && <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>}
        {env && (
          <>
            <MuiRadioGroup
              value={env}
              onChange={(e) => void onChange(e.target.value as KsefEnvironment)}
            >
              {envKeys.map((key) => (
                <MuiFormControlLabel
                  key={key}
                  value={key}
                  control={<MuiRadio size="small" />}
                  label={
                    <span>
                      <strong>{KSEF_ENVIRONMENTS[key].label}</strong>
                      <MuiTypography component="span" variant="caption" color="text.secondary">
                        {" — "}{KSEF_ENVIRONMENTS[key].apiBase}
                      </MuiTypography>
                    </span>
                  }
                />
              ))}
            </MuiRadioGroup>
            {env === "prod" && (
              <MuiAlert severity="warning" sx={{ mt: 1 }}>
                {t("options_ksef_env_prod_warning")}
              </MuiAlert>
            )}
          </>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Google ---------------------------------------------------------------

function GoogleSection() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await send<AuthStatus>({ type: "auth.status" });
    if (res.ok) setStatus(res.data);
  };

  useEffect(() => { void refresh(); }, []);

  const disconnect = async () => {
    setBusy(true);
    await send({ type: "auth.disconnect" });
    setBusy(false);
    await refresh();
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("section_google_account")}</MuiTypography>
        {!status && <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>}
        {status && !status.connected && (
          <MuiTypography variant="body2" color="text.secondary">{t("google_settings_not_connected")}</MuiTypography>
        )}
        {status?.connected && (
          <MuiStack spacing={2}>
            <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <MuiTypography variant="body2">{t("google_connected_as", status.email)}</MuiTypography>
              <MuiButton variant="outlined" color="error" size="small" disabled={busy} onClick={disconnect}>
                {t("google_disconnect_full")}
              </MuiButton>
            </MuiStack>
            <CalendarPicker />
          </MuiStack>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Target-calendar picker for "Add to Calendar" button -----------------

function CalendarPicker() {
  const [calendars, setCalendars] = useState<
    { id: string; summary: string; primary?: boolean }[] | null
  >(null);
  const [selected, setSelected] = useState<string>("primary");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [listRes, tgtRes] = await Promise.all([
        send<{ id: string; summary: string; primary?: boolean }[]>({ type: "calendar.list" }),
        send<string>({ type: "calendar.getTarget" }),
      ]);
      if (listRes.ok) setCalendars(listRes.data);
      else setError(listRes.error);
      if (tgtRes.ok) setSelected(tgtRes.data);
    })();
  }, []);

  const handleChange = async (id: string) => {
    setSelected(id);
    await send({ type: "calendar.setTarget", calendarId: id });
  };

  if (error) {
    return (
      <MuiAlert severity="warning">
        {/insufficient|403/i.test(error)
          ? t("options_calendar_needs_reconnect")
          : error}
      </MuiAlert>
    );
  }

  if (!calendars) return <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>;

  return (
    <MuiFormControl size="small" fullWidth>
      <MuiInputLabel>{t("options_target_calendar")}</MuiInputLabel>
      <MuiSelect
        value={selected}
        label={t("options_target_calendar")}
        onChange={(e) => void handleChange(e.target.value as string)}
      >
        {calendars.map((c) => (
          <MuiMenuItem key={c.id} value={c.id}>
            {c.summary}
            {c.primary ? " (primary)" : ""}
          </MuiMenuItem>
        ))}
      </MuiSelect>
    </MuiFormControl>
  );
}

// --- Sync settings --------------------------------------------------------

function SyncSection() {
  const [config, setConfig] = useState<AutoSyncConfig | null>(null);
  const [target, setTarget] = useState<TargetSpreadsheet | null | undefined>(undefined);
  const [trackingCleared, setTrackingCleared] = useState(false);
  const [fetchOnResume, setFetchOnResumeLocal] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      const [cfgRes, tgtRes, forRes] = await Promise.all([
        send<AutoSyncConfig>({ type: "autoSync.getConfig" }),
        send<TargetSpreadsheet | null>({ type: "sheets.getTarget" }),
        send<boolean>({ type: "fetchOnResume.get" }),
      ]);
      if (cfgRes.ok) setConfig(cfgRes.data);
      if (tgtRes.ok) setTarget(tgtRes.data);
      if (forRes.ok) setFetchOnResumeLocal(forRes.data);
    })();
  }, []);

  const toggleAutoSync = async (next: boolean) => {
    if (!config) return;
    setConfig({ ...config, enabled: next });
    const res = await send({ type: "autoSync.setEnabled", enabled: next });
    if (!res.ok) setConfig({ ...config, enabled: !next });
  };

  const toggleFetchOnResume = async (next: boolean) => {
    setFetchOnResumeLocal(next);
    const res = await send({ type: "fetchOnResume.set", enabled: next });
    if (!res.ok) setFetchOnResumeLocal(!next);
  };

  const clearTracking = async () => {
    await send({ type: "sheets.clearTracking" });
    setTrackingCleared(true);
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("section_sync")}</MuiTypography>
        <MuiStack spacing={2}>
          {config && (
            <>
              <MuiFormControlLabel
                control={
                  <MuiSwitch
                    checked={config.enabled}
                    onChange={(e) => void toggleAutoSync(e.target.checked)}
                  />
                }
                label={t("autosync_label_options", String(config.periodMinutes))}
              />
              <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <MuiTypography variant="body2">{t("options_sync_interval")}</MuiTypography>
                <MuiFormControl size="small" sx={{ minWidth: 120 }}>
                  <MuiSelect
                    value={String(config.periodMinutes)}
                    onChange={(e) => {
                      const mins = parseInt(e.target.value as string, 10);
                      setConfig({ ...config, periodMinutes: mins });
                      void send({ type: "autoSync.setInterval", minutes: mins });
                    }}
                  >
                    <MuiMenuItem value="30">30 min</MuiMenuItem>
                    <MuiMenuItem value="60">1h</MuiMenuItem>
                    <MuiMenuItem value="120">2h</MuiMenuItem>
                    <MuiMenuItem value="240">4h</MuiMenuItem>
                  </MuiSelect>
                </MuiFormControl>
              </MuiStack>
              {fetchOnResume !== null && (
                <MuiStack spacing={0.5}>
                  <MuiFormControlLabel
                    control={
                      <MuiSwitch
                        checked={fetchOnResume}
                        onChange={(e) => void toggleFetchOnResume(e.target.checked)}
                      />
                    }
                    label={t("options_fetch_on_resume")}
                  />
                  <MuiTypography variant="caption" color="text.secondary">
                    {t("options_fetch_on_resume_hint")}
                  </MuiTypography>
                </MuiStack>
              )}
            </>
          )}
          {target !== undefined && (
            <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <MuiTypography variant="body2">
                {t("options_target_sheet")}{" "}
                {target ? (
                  <strong>{target.name}</strong>
                ) : (
                  <MuiTypography component="span" variant="body2" color="text.secondary">
                    {t("options_target_none")}
                  </MuiTypography>
                )}
              </MuiTypography>
              {target && (
                <MuiButton
                  variant="outlined"
                  size="small"
                  onClick={clearTracking}
                  disabled={trackingCleared}
                >
                  {trackingCleared
                    ? t("options_tracking_cleared")
                    : t("options_clear_tracking")}
                </MuiButton>
              )}
            </MuiStack>
          )}
        </MuiStack>
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Notifications --------------------------------------------------------

function NotificationsSection() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await send<NotificationConfig>({ type: "notifications.getConfig" });
      if (res.ok) setConfig(res.data);
    })();
  }, []);

  const toggle = async (key: keyof NotificationConfig, next: boolean) => {
    if (!config) return;
    setConfig({ ...config, [key]: next });
    const res = await send({ type: "notifications.setConfig", config: { [key]: next } });
    if (!res.ok) setConfig({ ...config, [key]: !next });
  };

  const toggles: Array<{ key: keyof NotificationConfig; label: string }> = [
    { key: "syncResult", label: t("notif_toggle_sync_result") },
    { key: "newInvoices", label: t("notif_toggle_new_invoices") },
    { key: "syncError", label: t("notif_toggle_sync_error") },
    { key: "incomingInvoices", label: t("notif_toggle_incoming") },
  ];

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("options_notifications")}</MuiTypography>
        {!config && <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>}
        {config && (
          <MuiFormGroup>
            {toggles.map(({ key, label }) => (
              <MuiFormControlLabel
                key={key}
                control={
                  <MuiCheckbox
                    size="small"
                    checked={config[key]}
                    onChange={(e) => void toggle(key, e.target.checked)}
                  />
                }
                label={label}
              />
            ))}
          </MuiFormGroup>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Vault ----------------------------------------------------------------

function VaultSection() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [remember, setRemember] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await send<VaultStatus>({ type: "vault.status" });
    if (res.ok) setStatus(res.data);
  };

  useEffect(() => {
    void refresh();
    void send<{ remember: boolean }>({ type: "vault.getRemember" }).then((res) => {
      if (res.ok) setRemember(res.data.remember);
    });
  }, []);

  const toggleRemember = async (next: boolean) => {
    setRemember(next);
    const res = await send({ type: "vault.setRemember", enabled: next });
    if (!res.ok) setRemember(!next);
  };

  const lock = async () => {
    setBusy(true);
    await send({ type: "vault.lock" });
    setBusy(false);
    await refresh();
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("section_vault")}</MuiTypography>
        <MuiStack spacing={1.5}>
          {!status && <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>}
          {status && !status.initialized && (
            <MuiTypography variant="body2" color="text.secondary">{t("vault_not_initialized")}</MuiTypography>
          )}
          {status?.initialized && !status.unlocked && (
            <MuiTypography variant="body2" color="text.secondary">{t("vault_locked")}</MuiTypography>
          )}
          {status?.initialized && status.unlocked && (
            <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <MuiTypography variant="body2" sx={{ color: "success.main" }}>{t("vault_unlocked")}</MuiTypography>
              <MuiButton variant="outlined" size="small" disabled={busy} onClick={lock}>
                {t("button_lock")}
              </MuiButton>
            </MuiStack>
          )}
          {remember !== null && (
            <MuiStack spacing={0.5}>
              <MuiFormControlLabel
                control={
                  <MuiCheckbox
                    size="small"
                    checked={remember}
                    onChange={(e) => void toggleRemember(e.target.checked)}
                  />
                }
                label={t("vault_remember")}
              />
              {remember && (
                <MuiTypography variant="caption" color="text.secondary">
                  {t("vault_remember_warning")}
                </MuiTypography>
              )}
            </MuiStack>
          )}
        </MuiStack>
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Logs viewer ----------------------------------------------------------

function LogsSection() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await send<string[]>({ type: "logs.get" });
    setLogs(res.ok ? res.data : [`error: ${!res.ok ? res.error : ""}`]);
    setLoading(false);
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !logs) void load();
  };

  const copy = async () => {
    if (!logs) return;
    await navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const clear = async () => {
    await send({ type: "logs.clear" });
    setLogs([]);
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
          <MuiTypography variant="h6">{t("options_logs_title")}</MuiTypography>
          <MuiStack direction="row" spacing={0.5} alignItems="center">
            <MuiIconButton
              size="small"
              onClick={toggle}
              title={open ? t("options_logs_hide") : t("options_logs_show")}
              aria-label={open ? t("options_logs_hide") : t("options_logs_show")}
            >
              {open ? "▲" : "▼"}
            </MuiIconButton>
            {open && logs && (
              <>
                <MuiIconButton
                  size="small"
                  onClick={() => void load()}
                  disabled={loading}
                  title={t("options_logs_refresh")}
                  aria-label={t("options_logs_refresh")}
                >↻</MuiIconButton>
                <MuiIconButton
                  size="small"
                  onClick={() => void copy()}
                  disabled={!logs.length}
                  title={copied ? t("options_logs_copied") : t("options_logs_copy")}
                  aria-label={t("options_logs_copy")}
                >{copied ? "✓" : "⎘"}</MuiIconButton>
                <MuiIconButton
                  size="small"
                  onClick={() => void clear()}
                  title={t("options_logs_clear")}
                  aria-label={t("options_logs_clear")}
                >🗑</MuiIconButton>
              </>
            )}
          </MuiStack>
        </MuiStack>
        {open && (
          <MuiPaper
            variant="outlined"
            sx={{
              p: 1,
              bgcolor: "grey.900",
              color: "grey.100",
              fontFamily: "monospace",
              fontSize: 11,
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {loading
                ? t("status_loading")
                : !logs || logs.length === 0
                  ? t("options_logs_empty")
                  : logs.join("\n")}
            </pre>
          </MuiPaper>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

// --- Danger zone ----------------------------------------------------------

function DangerZone() {
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const destroyVault = async () => {
    await send({ type: "vault.destroy" });
    setConfirmDestroy(false);
    setDone(t("danger_vault_destroyed"));
  };

  const resetAll = async () => {
    await send({ type: "vault.destroy" });
    await send({ type: "auth.disconnect" });
    await send({ type: "config.destroyAll" });
    setConfirmReset(false);
    setDone(t("danger_all_cleared"));
  };

  return (
    <MuiCard variant="outlined">
      <MuiCardContent>
        <MuiTypography variant="h6" sx={{ mb: 2 }}>{t("section_danger_zone")}</MuiTypography>
        {done && <MuiAlert severity="success">{done}</MuiAlert>}

        {!done && (
          <MuiStack spacing={2}>
            <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <MuiStack spacing={0.5} flex={1}>
                <MuiTypography variant="body2" sx={{ fontWeight: 600 }}>{t("danger_destroy_vault")}</MuiTypography>
                <MuiTypography variant="caption" color="text.secondary">{t("danger_destroy_vault_desc")}</MuiTypography>
              </MuiStack>
              {!confirmDestroy ? (
                <MuiButton variant="outlined" color="error" onClick={() => setConfirmDestroy(true)}>
                  {t("danger_destroy_vault")}
                </MuiButton>
              ) : (
                <MuiStack direction="row" spacing={1}>
                  <MuiButton variant="outlined" color="error" onClick={destroyVault}>
                    {t("button_confirm")}
                  </MuiButton>
                  <MuiButton variant="outlined" onClick={() => setConfirmDestroy(false)}>
                    {t("button_cancel")}
                  </MuiButton>
                </MuiStack>
              )}
            </MuiStack>

            <MuiStack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <MuiStack spacing={0.5} flex={1}>
                <MuiTypography variant="body2" sx={{ fontWeight: 600 }}>{t("danger_reset_all")}</MuiTypography>
                <MuiTypography variant="caption" color="text.secondary">{t("danger_reset_all_desc")}</MuiTypography>
              </MuiStack>
              {!confirmReset ? (
                <MuiButton variant="outlined" color="error" onClick={() => setConfirmReset(true)}>
                  {t("danger_reset_all")}
                </MuiButton>
              ) : (
                <MuiStack direction="row" spacing={1}>
                  <MuiButton variant="outlined" color="error" onClick={resetAll}>
                    {t("button_confirm")}
                  </MuiButton>
                  <MuiButton variant="outlined" onClick={() => setConfirmReset(false)}>
                    {t("button_cancel")}
                  </MuiButton>
                </MuiStack>
              )}
            </MuiStack>
          </MuiStack>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}
