// SPDX-License-Identifier: GPL-3.0-or-later
// Popup root — tabbed layout: Status (default) | Config
import { useEffect, useState } from "react";
import { t } from "../shared/i18n";
import type {
  AuthStatus,
  AutoSyncConfig,
  IncomingInvoiceItem,
  Message,
  Response,
  SyncResult,
  VaultStatus,
} from "../shared/messages";
import type { LastSyncStats, NotificationConfig } from "../storage/persistent-config";
import { classifyError } from "../shared/errors";
import MuiButton from "@mui/material/Button";
import MuiCheckbox from "@mui/material/Checkbox";
import MuiCard from "@mui/material/Card";
import MuiCardContent from "@mui/material/CardContent";
import MuiFormControlLabel from "@mui/material/FormControlLabel";
import MuiFormControl from "@mui/material/FormControl";
import MuiInputLabel from "@mui/material/InputLabel";
import MuiSelect from "@mui/material/Select";
import MuiMenuItem from "@mui/material/MenuItem";
import MuiTextField from "@mui/material/TextField";
import MuiStack from "@mui/material/Stack";
import MuiTypography from "@mui/material/Typography";
import MuiBox from "@mui/material/Box";
import MuiList from "@mui/material/List";
import MuiListItemButton from "@mui/material/ListItemButton";
import MuiAlert from "@mui/material/Alert";
import MuiIconButton from "@mui/material/IconButton";
import MuiBadge from "@mui/material/Badge";
import MuiCardActionArea from "@mui/material/CardActionArea";
import MuiChip from "@mui/material/Chip";
import MuiCircularProgress from "@mui/material/CircularProgress";
import MuiCollapse from "@mui/material/Collapse";
import MuiLinearProgress from "@mui/material/LinearProgress";
import MuiLink from "@mui/material/Link";
import MuiTabs from "@mui/material/Tabs";
import MuiTab from "@mui/material/Tab";
import MuiDialog from "@mui/material/Dialog";
import MuiDialogTitle from "@mui/material/DialogTitle";
import MuiDialogContent from "@mui/material/DialogContent";
import MuiDialogActions from "@mui/material/DialogActions";
import MuiDivider from "@mui/material/Divider";
import MuiTable from "@mui/material/Table";
import MuiTableContainer from "@mui/material/TableContainer";
import MuiTableHead from "@mui/material/TableHead";
import MuiTableBody from "@mui/material/TableBody";
import MuiTableRow from "@mui/material/TableRow";
import MuiTableCell from "@mui/material/TableCell";
import MuiPaper from "@mui/material/Paper";

type Tab = "status" | "config";
const TAB_KEY = "popup.activeTab";

export function App() {
  const [tab, setTab] = useState<Tab>("status");
  const [envLabel, setEnvLabel] = useState("");
  const [envWebApp, setEnvWebApp] = useState("https://ap-test.ksef.mf.gov.pl");
  const [dark, setDark] = useState(false);

  // Restore last tab
  useEffect(() => {
    void chrome.storage.session.get(TAB_KEY).then((r) => {
      if (r[TAB_KEY] === "config") setTab("config");
    });
    // Restore theme — Pico CSS uses html[data-theme]; shadcn uses .dark class
    void chrome.storage.local.get("config.theme").then((r) => {
      const theme = r["config.theme"] as string | undefined;
      const isDark = theme === "dark" || (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
      setDark(isDark);
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.classList.toggle("light", !isDark);
    });
    void send({ type: "ksef.getEnvironment" }).then((res) => {
      if (res.ok) {
        const d = res.data as { badge: string; webApp: string };
        setEnvLabel(d.badge);
        setEnvWebApp(d.webApp);
      }
    });
  }, []);

  const switchTab = (next: Tab) => {
    setTab(next);
    void chrome.storage.session.set({ [TAB_KEY]: next });
  };

  return (
    <div className="app">
      <MuiStack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <MuiTypography variant="subtitle1" sx={{ fontWeight: 700, flex: 1, lineHeight: 1.2 }}>
          {t("app_title")}
        </MuiTypography>
        <MuiChip size="small" color="warning" label={envLabel || "TEST"} />
        <MuiIconButton
          size="small"
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
            document.documentElement.classList.toggle("dark", next);
            document.documentElement.classList.toggle("light", !next);
            void chrome.storage.local.set({ "config.theme": next ? "dark" : "light" });
          }}
          title={dark ? "Light mode" : "Dark mode"}
        >
          {dark ? "☀" : "☾"}
        </MuiIconButton>
      </MuiStack>
      <MuiTabs
        value={tab}
        onChange={(_, v) => switchTab(v as Tab)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 36 }}
      >
        <MuiTab label={t("tab_status")} value="status" sx={{ minHeight: 36, py: 0.5 }} />
        <MuiTab label={t("tab_config")} value="config" sx={{ minHeight: 36, py: 0.5 }} />
      </MuiTabs>
      <main>
        {tab === "status" && <StatusTab ksefWebApp={envWebApp} />}
        {tab === "config" && <ConfigTab />}
      </main>
    </div>
  );
}

// =========================================================================
// STATUS TAB
// =========================================================================

function StatusTab({ ksefWebApp }: { ksefWebApp: string }) {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [stats, setStats] = useState<LastSyncStats | null>(null);
  const [incoming, setIncoming] = useState<IncomingInvoiceItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextSyncPct, setNextSyncPct] = useState<number | null>(null);
  const [unlockPass, setUnlockPass] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [viewingInvoice, setViewingInvoice] = useState<string | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<Record<string, { htmlLink: string }>>({});
  const [sheetsEnabled, setSheetsEnabled] = useState<boolean>(true);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);

  const refresh = async () => {
    const [vRes, sRes, iRes, uRes, cRes, seRes] = await Promise.all([
      send<VaultStatus>({ type: "vault.status" }),
      send<LastSyncStats | null>({ type: "dashboard.getStats" }),
      send<IncomingInvoiceItem[]>({ type: "incoming.getRecent" }),
      send<string | null>({ type: "sheets.getUrl" }),
      send<Record<string, { htmlLink: string }>>({ type: "calendar.getAllEvents" }),
      send<boolean>({ type: "sheets.enabled.get" }),
    ]);
    if (cRes.ok) setCalendarEvents(cRes.data);
    if (seRes.ok) setSheetsEnabled(seRes.data);
    if (vRes.ok) setVault(vRes.data);
    if (sRes.ok && sRes.data) setStats(sRes.data);
    if (iRes.ok) {
      setIncoming(iRes.data);
      void send({ type: "incoming.markRead" });
    }
    if (uRes.ok && uRes.data) {
      setSheetUrl(uRes.data);
    } else {
      // Fallback: build URL from target spreadsheet ID if URL wasn't persisted
      const tRes = await send<{ id: string; name: string } | null>({ type: "sheets.getTarget" });
      if (tRes.ok && tRes.data) {
        setSheetUrl(`https://docs.google.com/spreadsheets/d/${tRes.data.id}/edit`);
      }
    }
  };

  // Auto-refresh + sync countdown timer + storage-change subscription
  // (so counts stay live when auto-sync adds invoices while popup is open).
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void updateSyncCountdown(setNextSyncPct);
    }, 5000);
    void updateSyncCountdown(setNextSyncPct);

    const onStorageChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "local") return;
      if (
        "sync.lastStats" in changes ||
        "sync.incoming.feed" in changes ||
        "config.invoiceCalendarEvents" in changes
      ) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const handleSync = async () => {
    setSyncing(true); setError(null);
    const res = await send<SyncResult>({ type: "sync.run" });
    setSyncing(false);
    if (!res.ok) { setError(res.error); return; }
    setSyncResult(res.data);
    void refresh();
  };

  const handleUnlock = async () => {
    if (!unlockPass) return;
    setUnlockBusy(true); setUnlockError(null);
    const res = await send<{ unlocked: boolean }>({ type: "vault.unlock", passphrase: unlockPass });
    setUnlockBusy(false);
    if (!res.ok) { setUnlockError(res.error); return; }
    if (!res.data.unlocked) { setUnlockError(t("error_wrong_passphrase")); return; }
    setUnlockPass("");
    void refresh();
  };

  if (!vault) return <p className="muted small pad">{t("status_loading")}</p>;

  // Not configured → point to Config tab
  if (!vault.initialized || (!vault.unlocked && !vault.hasKsefToken)) {
    return (
      <div className="pad">
        <p className="muted small">{t("status_not_configured")}</p>
        <p className="muted small">{t("status_go_to_config")}</p>
      </div>
    );
  }

  // Locked → show unlock form right here on Status tab
  if (!vault.unlocked) {
    return (
      <MuiStack spacing={1} sx={{ p: 2 }}>
        <MuiTypography variant="body2" color="text.secondary">
          {t("unlock_description")}
        </MuiTypography>
        <MuiStack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <MuiTextField
            type="password"
            size="small"
            fullWidth
            value={unlockPass}
            onChange={(e) => setUnlockPass(e.target.value)}
            placeholder={t("placeholder_unlock")}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void handleUnlock(); }}
          />
          <MuiButton
            variant="contained"
            onClick={handleUnlock}
            disabled={unlockBusy || !unlockPass}
          >
            {unlockBusy ? t("button_unlock_busy") : t("button_unlock")}
          </MuiButton>
        </MuiStack>
        {unlockError && <MuiAlert severity="error" sx={{ mt: 1 }}>{unlockError}</MuiAlert>}
      </MuiStack>
    );
  }

  const unreadCount = incoming.filter((i) => i.isNew).length;

  return (
    <div className="status-tab">
      {/* Status bar */}
      {(syncing || error || syncResult) && (
        <MuiStack sx={{ p: 1.5 }}>
          {syncing ? (
            <MuiTypography variant="body2" color="text.secondary">{t("status_syncing")}</MuiTypography>
          ) : error ? (
            <MuiAlert
              severity="error"
              action={
                <MuiIconButton
                  size="small"
                  onClick={() => setErrorDetailsOpen((o) => !o)}
                  title={t("error_details")}
                  color="inherit"
                >
                  {errorDetailsOpen ? "▾" : "▸"}
                </MuiIconButton>
              }
            >
              <MuiTypography variant="body2">{classifyError(error).hint}</MuiTypography>
              <MuiCollapse in={errorDetailsOpen}>
                <MuiTypography variant="caption" sx={{ display: "block", mt: 0.5, wordBreak: "break-word" }}>
                  {error}
                </MuiTypography>
              </MuiCollapse>
            </MuiAlert>
          ) : syncResult ? (
            <MuiTypography variant="body2" color="success.main">
              {t("sync_result", String(syncResult.totalCount), (syncResult.durationMs / 1000).toFixed(1))}
            </MuiTypography>
          ) : null}
        </MuiStack>
      )}

      {/* Stats with +N delta */}
      {stats && (
        <MuiBox sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
          {[
            { value: stats.totalOutgoing, delta: stats.appendedRows, label: t("dashboard_outgoing") },
            { value: stats.totalIncoming, delta: stats.newIncoming, label: t("dashboard_incoming") },
            { value: formatTimeAgo(stats.syncedAt), delta: 0, label: t("dashboard_last_sync") },
          ].map((s, i) => (
            <MuiBox key={i} sx={{ textAlign: "center", minWidth: 0 }}>
              <MuiTypography sx={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                {s.value}
                {s.delta > 0 && (
                  <MuiTypography component="span" variant="caption" sx={{ ml: 0.5, color: "success.main", fontWeight: 600, verticalAlign: "super" }}>
                    +{s.delta}
                  </MuiTypography>
                )}
              </MuiTypography>
              <MuiTypography color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10, whiteSpace: "nowrap", mt: 0.25 }}>
                {s.label}
              </MuiTypography>
            </MuiBox>
          ))}
        </MuiBox>
      )}

      {/* Next sync progress bar */}
      {nextSyncPct !== null && (
        <MuiLinearProgress variant="determinate" value={nextSyncPct} sx={{ height: 2 }} />
      )}

      {/* Incoming feed header — title left, action icons right, single row */}
      <MuiStack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "nowrap", px: 2, py: 1, minHeight: 44 }}
      >
        <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, flex: 1 }}>
          <MuiTypography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {t("feed_incoming_title")}
          </MuiTypography>
          {unreadCount > 0 && (
            <MuiChip size="small" color="primary" label={unreadCount} sx={{ flexShrink: 0 }} />
          )}
        </MuiStack>
        <MuiStack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          {unreadCount > 0 && (
            <MuiIconButton size="small" title={t("feed_read_all")} onClick={() => {
              void send({ type: "incoming.markRead" }).then(() => {
                setIncoming(incoming.map((i) => ({ ...i, isNew: false })));
              });
            }}>✓</MuiIconButton>
          )}
          {incoming.length > 0 && (
            <MuiIconButton size="small" title={t("feed_clear_all")} onClick={() => {
              void send({ type: "incoming.clearAll" }).then(() => setIncoming([]));
            }}>✕</MuiIconButton>
          )}
        </MuiStack>
      </MuiStack>

      <MuiList disablePadding sx={{ borderTop: 1, borderColor: "divider" }}>
        {incoming.length === 0 && (
          <MuiTypography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
            {t("feed_empty")}
          </MuiTypography>
        )}
        {incoming.map((inv) => (
          <MuiBox
            key={inv.ksefNumber}
            onMouseEnter={() => {
              if (inv.isNew) {
                setIncoming(incoming.map((i) =>
                  i.ksefNumber === inv.ksefNumber ? { ...i, isNew: false } : i,
                ));
              }
            }}
            sx={{
              borderBottom: 1,
              borderColor: "divider",
              bgcolor: inv.isNew ? "action.hover" : "transparent",
              "&:hover": { bgcolor: "action.hover" },
              "&:hover .feed-actions": { opacity: 1 },
              position: "relative",
            }}
          >
            {inv.isNew && (
              <MuiBox sx={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, bgcolor: "primary.main" }} />
            )}
            <MuiListItemButton
              onClick={() => setViewingInvoice(inv.ksefNumber)}
              sx={{ py: 1, px: 2, display: "block" }}
            >
              <MuiStack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mb: 0.25 }}>
                <MuiTypography variant="body2" sx={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pr: 1 }}>
                  {inv.sellerName || inv.sellerNip}
                </MuiTypography>
                <MuiTypography variant="body2" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {inv.grossAmount.toLocaleString()} {inv.currency}
                </MuiTypography>
              </MuiStack>
              <MuiStack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <MuiTypography variant="caption" color="text.secondary" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", pr: 1 }}>
                  {inv.invoiceNumber}
                </MuiTypography>
                <MuiTypography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                  {inv.issueDate}
                </MuiTypography>
              </MuiStack>
            </MuiListItemButton>
            <MuiStack
              className="feed-actions"
              direction="row"
              spacing={0}
              sx={{
                position: "absolute",
                right: 6,
                bottom: 2,
                opacity: 0.55,
                transition: "opacity 120ms",
                bgcolor: "background.paper",
                borderRadius: 1,
              }}
            >
              {calendarEvents[inv.ksefNumber] && (
                <MuiIconButton
                  size="small"
                  component="a"
                  href={calendarEvents[inv.ksefNumber].htmlLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("feed_open_calendar_event")}
                  sx={{ fontSize: 14 }}
                >📅</MuiIconButton>
              )}
              <MuiIconButton size="small" title={t("invoice_download_xml")} sx={{ fontSize: 14 }} onClick={(e) => {
                e.stopPropagation();
                void downloadInvoiceXml(inv.ksefNumber, inv.invoiceNumber);
              }}>⤓</MuiIconButton>
              <MuiIconButton size="small" title={t("feed_copy")} sx={{ fontSize: 14 }} onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard.writeText(
                  `${inv.invoiceNumber} | ${inv.sellerName} | ${inv.grossAmount} ${inv.currency} | ${inv.ksefNumber}`
                );
              }}>⎘</MuiIconButton>
              <MuiIconButton size="small" title={t("feed_remove")} sx={{ fontSize: 14 }} onClick={(e) => {
                e.stopPropagation();
                void send({ type: "incoming.remove", ksefNumber: inv.ksefNumber }).then(() => {
                  setIncoming(incoming.filter((i) => i.ksefNumber !== inv.ksefNumber));
                });
              }}>✕</MuiIconButton>
            </MuiStack>
          </MuiBox>
        ))}
      </MuiList>

      {/* Action row: interval select + open sheet + sync */}
      <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", p: 1.5, borderTop: 1, borderColor: "divider" }}>
        <SyncIntervalSelect />
        {sheetsEnabled && sheetUrl && (
          <MuiIconButton
            component="a"
            size="small"
            href={sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t("sync_open_sheets")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="3" y1="15" x2="21" y2="15" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </MuiIconButton>
        )}
        <MuiButton
          variant="contained"
          onClick={handleSync}
          disabled={syncing}
          startIcon={syncing ? <MuiCircularProgress size={16} color="inherit" /> : null}
          sx={{ ml: "auto" }}
        >
          {syncing ? t("status_syncing") : t("button_sync")}
        </MuiButton>
      </MuiStack>

      {viewingInvoice && (
        <InvoiceViewer
          ksefNumber={viewingInvoice}
          ksefWebApp={ksefWebApp}
          onClose={() => setViewingInvoice(null)}
        />
      )}
    </div>
  );
}

// =========================================================================
// INVOICE VIEWER MODAL
// =========================================================================

function InvoiceViewer({
  ksefNumber, ksefWebApp, onClose,
}: {
  ksefNumber: string;
  ksefWebApp: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; invoice: import("../ksef/fa3-parser").ParsedInvoice; xml: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      const res = await send<string>({ type: "invoice.fetchXml", ksefNumber });
      if (!res.ok) { setState({ kind: "error", message: res.error }); return; }
      try {
        const { parseFa3 } = await import("../ksef/fa3-parser");
        const invoice = parseFa3(res.data);
        setState({ kind: "ok", invoice, xml: res.data });
      } catch (err) {
        setState({ kind: "error", message: (err as Error).message });
      }
    })();
  }, [ksefNumber]);

  const downloadXml = (xml: string, invoiceNumber: string) => {
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${invoiceNumber.replace(/[/\\]/g, "_")}.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const daysUntilDue = (isoDate: string | null): number | null => {
    if (!isoDate) return null;
    const ms = new Date(isoDate).getTime() - Date.now();
    return Math.ceil(ms / (24 * 3600_000));
  };

  const inv = state.kind === "ok" ? state.invoice : null;

  return (
    <MuiDialog open fullWidth maxWidth="sm" onClose={onClose}>
      <MuiDialogTitle sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {inv ? inv.invoiceNumber : t("status_loading")}
        <MuiIconButton size="small" onClick={onClose}><span aria-hidden>×</span></MuiIconButton>
      </MuiDialogTitle>
      <MuiDialogContent dividers>
        {state.kind === "loading" && (
          <MuiTypography variant="body2" color="text.secondary">{t("status_loading")}</MuiTypography>
        )}
        {state.kind === "error" && (
          <MuiAlert severity="error">{state.message}</MuiAlert>
        )}
        {state.kind === "ok" && inv && (() => {
          const daysDue = daysUntilDue(inv.dueDate);
          const dueSeverity: "success" | "error" | "warning" | "info" = inv.paid
            ? "success"
            : daysDue !== null && daysDue < 0
              ? "error"
              : daysDue !== null && daysDue <= 7
                ? "warning"
                : "info";
          return (
            <>
              <MuiTypography variant="body2" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
                {inv.issueDate}{inv.sellDate && inv.sellDate !== inv.issueDate ? ` · sprzedaż ${inv.sellDate}` : ""}
              </MuiTypography>

              {inv.dueDate && (
                <MuiAlert severity={dueSeverity} variant="filled" sx={{ mb: 2, fontSize: 14 }}>
                  <strong>{t("invoice_due")}: {inv.dueDate}</strong>
                  {!inv.paid && daysDue !== null && (
                    <span> · {daysDue < 0 ? t("invoice_overdue_by", String(-daysDue)) : daysDue === 0 ? t("invoice_due_today") : t("invoice_due_in", String(daysDue))}</span>
                  )}
                  {inv.paid && <span> · {t("invoice_paid")}</span>}
                </MuiAlert>
              )}

              <MuiStack direction="row" spacing={2} divider={<MuiDivider orientation="vertical" flexItem />} sx={{ mb: 2 }}>
                <MuiStack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                  <MuiTypography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "text.secondary", textTransform: "uppercase" }}>
                    {t("invoice_seller")}
                  </MuiTypography>
                  <MuiTypography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>{inv.seller.name}</MuiTypography>
                  <MuiTypography variant="body2" color="text.secondary">NIP {inv.seller.nip}</MuiTypography>
                  <MuiTypography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>{inv.seller.address}</MuiTypography>
                </MuiStack>
                <MuiStack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                  <MuiTypography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "text.secondary", textTransform: "uppercase" }}>
                    {t("invoice_buyer")}
                  </MuiTypography>
                  <MuiTypography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>{inv.buyer.name}</MuiTypography>
                  <MuiTypography variant="body2" color="text.secondary">NIP {inv.buyer.nip}</MuiTypography>
                  <MuiTypography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>{inv.buyer.address}</MuiTypography>
                </MuiStack>
              </MuiStack>

              <MuiTableContainer component={MuiPaper} variant="outlined" sx={{ my: 2, bgcolor: "background.default" }}>
                <MuiTable size="small">
                  <MuiTableHead>
                    <MuiTableRow>
                      <MuiTableCell sx={{ fontWeight: 700, fontSize: 12 }}>#</MuiTableCell>
                      <MuiTableCell sx={{ fontWeight: 700, fontSize: 12 }}>{t("invoice_col_desc")}</MuiTableCell>
                      <MuiTableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>{t("invoice_col_qty")}</MuiTableCell>
                      <MuiTableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>{t("invoice_col_price")}</MuiTableCell>
                      <MuiTableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>{t("invoice_col_net")}</MuiTableCell>
                      <MuiTableCell align="right" sx={{ fontWeight: 700, fontSize: 12 }}>VAT</MuiTableCell>
                    </MuiTableRow>
                  </MuiTableHead>
                  <MuiTableBody>
                    {inv.lines.map((line) => (
                      <MuiTableRow key={line.no}>
                        <MuiTableCell sx={{ fontSize: 12 }}>{line.no}</MuiTableCell>
                        <MuiTableCell sx={{ fontSize: 12 }}>{line.description}</MuiTableCell>
                        <MuiTableCell align="right" sx={{ fontSize: 12, whiteSpace: "nowrap" }}>{line.quantity} {line.unit}</MuiTableCell>
                        <MuiTableCell align="right" sx={{ fontSize: 12 }}>{line.unitPriceNet.toLocaleString()}</MuiTableCell>
                        <MuiTableCell align="right" sx={{ fontSize: 12 }}>{line.lineNet.toLocaleString()}</MuiTableCell>
                        <MuiTableCell align="right" sx={{ fontSize: 12 }}>{line.vatRate}%</MuiTableCell>
                      </MuiTableRow>
                    ))}
                  </MuiTableBody>
                </MuiTable>
              </MuiTableContainer>

              <MuiStack spacing={0.5} sx={{ alignItems: "flex-end", mt: 2 }}>
                <MuiTypography variant="body1">
                  {t("invoice_net")}: <strong>{inv.totals.net.toLocaleString()} {inv.currency}</strong>
                </MuiTypography>
                <MuiTypography variant="body1">
                  VAT: <strong>{inv.totals.vat.toLocaleString()} {inv.currency}</strong>
                </MuiTypography>
                <MuiTypography variant="h6" sx={{ fontWeight: 700, color: "primary.main" }}>
                  {t("invoice_gross")}: {inv.totals.gross.toLocaleString()} {inv.currency}
                </MuiTypography>
              </MuiStack>
            </>
          );
        })()}
      </MuiDialogContent>
      {state.kind === "ok" && inv && (
        <MuiDialogActions>
          {inv.dueDate && !inv.paid && (
            <CalendarButton invoice={inv} ksefNumber={ksefNumber} />
          )}
          <MuiButton
            variant="outlined"
            startIcon={<span>⤓</span>}
            onClick={() => downloadXml(state.xml, inv.invoiceNumber)}
          >
            {t("invoice_download_xml")}
          </MuiButton>
        </MuiDialogActions>
      )}
    </MuiDialog>
  );
}

// =========================================================================
// CONFIG TAB
// =========================================================================

function ConfigTab() {
  return (
    <div className="config-tab">
      <GoogleConfig />
      <SheetsConfig />
      <CalendarConfig />
      <VaultConfig />
      <NotificationsConfig />
      <CatchUpConfig />
      <ConnectionTestSection />
      <LogsConfig />
      <AdvancedSettingsLink />
    </div>
  );
}

function AdvancedSettingsLink() {
  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <MuiStack spacing={0.25}>
            <MuiTypography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {t("config_advanced_title")}
            </MuiTypography>
            <MuiTypography variant="caption" color="text.secondary">
              {t("config_advanced_hint")}
            </MuiTypography>
          </MuiStack>
          <MuiButton
            size="small"
            variant="outlined"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            {t("button_settings")}
          </MuiButton>
        </MuiStack>
        <MuiTypography variant="caption" color="text.secondary" sx={{ display: "block", textAlign: "center", mt: 1.5 }}>
          {t("footer_license")}
        </MuiTypography>
      </MuiCardContent>
    </MuiCard>
  );
}

function SheetsConfig() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [outgoing, setOutgoing] = useState<boolean | null>(null);
  const [incoming, setIncoming] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [target, setTarget] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [sheets, setSheets] = useState<
    { id: string; name: string; webViewLink?: string }[] | null
  >(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadTarget = async () => {
    const r = await send<{ id: string; name: string } | null>({ type: "sheets.getTarget" });
    if (r.ok) setTarget(r.data);
  };

  useEffect(() => {
    void (async () => {
      const a = await send<AuthStatus>({ type: "auth.status" });
      const isConnected = a.ok && (a.data as AuthStatus).connected;
      setConnected(!!isConnected);
      const [enRes, outRes, inRes] = await Promise.all([
        send<boolean>({ type: "sheets.enabled.get" }),
        send<boolean>({ type: "sheets.syncOutgoing.get" }),
        send<boolean>({ type: "sheets.syncIncoming.get" }),
      ]);
      setEnabled(enRes.ok ? enRes.data : true);
      setOutgoing(outRes.ok ? outRes.data : true);
      setIncoming(inRes.ok ? inRes.data : true);
      if (isConnected) await loadTarget();
    })();
  }, []);

  if (!connected) return null;
  if (enabled === null || outgoing === null || incoming === null) return null;

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    await send({ type: "sheets.enabled.set", enabled: next });
  };

  const toggleOutgoing = async (next: boolean) => {
    setOutgoing(next);
    await send({ type: "sheets.syncOutgoing.set", enabled: next });
  };

  const toggleIncoming = async (next: boolean) => {
    setIncoming(next);
    await send({ type: "sheets.syncIncoming.set", enabled: next });
  };

  const openPicker = async () => {
    setPickerOpen(true);
    const r = await send<{ id: string; name: string; webViewLink?: string }[]>({ type: "sheets.list" });
    if (r.ok) setSheets(r.data);
  };

  const pick = async (id: string, name: string) => {
    await send({ type: "sheets.setTarget", id, name });
    setTarget({ id, name });
    setPickerOpen(false);
  };

  const clearTarget = async () => {
    await send({ type: "sheets.clearTarget" });
    setTarget(null);
    setPickerOpen(false);
  };

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("config_sheets_section")}
        </MuiTypography>
        <MuiFormControlLabel
          control={
            <MuiCheckbox
              size="small"
              checked={enabled}
              onChange={(e) => void toggleEnabled(e.target.checked)}
            />
          }
          label={<MuiTypography variant="body2">{t("config_sheets_enable")}</MuiTypography>}
        />
        {enabled && (
          <MuiStack spacing={1} sx={{ mt: 1 }}>
            <MuiStack sx={{ pl: 1 }}>
              <MuiFormControlLabel
                control={
                  <MuiCheckbox
                    size="small"
                    checked={outgoing}
                    onChange={(e) => void toggleOutgoing(e.target.checked)}
                  />
                }
                label={<MuiTypography variant="caption">{t("config_sheets_outgoing")}</MuiTypography>}
              />
              <MuiFormControlLabel
                control={
                  <MuiCheckbox
                    size="small"
                    checked={incoming}
                    onChange={(e) => void toggleIncoming(e.target.checked)}
                  />
                }
                label={<MuiTypography variant="caption">{t("config_sheets_incoming")}</MuiTypography>}
              />
            </MuiStack>
            <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
              <MuiTypography variant="caption">
                {t("picker_target")}{" "}
                {target ? (
                  <strong>{target.name}</strong>
                ) : (
                  <MuiTypography component="span" variant="caption" color="text.secondary">
                    {t("picker_no_target")}
                  </MuiTypography>
                )}
              </MuiTypography>
              <MuiButton size="small" variant="outlined" onClick={() => void openPicker()}>
                {t("picker_change")}
              </MuiButton>
            </MuiStack>
            {pickerOpen && (
              <MuiStack spacing={0.5} sx={{ borderTop: 1, borderColor: "divider", pt: 1, maxHeight: 200, overflowY: "auto" }}>
                {!sheets ? (
                  <MuiTypography variant="caption" color="text.secondary">{t("picker_loading_sheets")}</MuiTypography>
                ) : sheets.length === 0 ? (
                  <MuiTypography variant="caption" color="text.secondary">{t("picker_no_sheets")}</MuiTypography>
                ) : (
                  sheets.map((s) => (
                    <MuiButton
                      key={s.id}
                      size="small"
                      variant="outlined"
                      sx={{ justifyContent: "flex-start", textTransform: "none" }}
                      onClick={() => void pick(s.id, s.name)}
                    >
                      {s.name}
                    </MuiButton>
                  ))
                )}
                <MuiStack direction="row" spacing={1} sx={{ pt: 0.5 }}>
                  <MuiButton size="small" variant="contained" onClick={() => void clearTarget()}>
                    {t("picker_create_new")}
                  </MuiButton>
                  <MuiButton size="small" variant="text" onClick={() => setPickerOpen(false)}>
                    {t("button_cancel")}
                  </MuiButton>
                </MuiStack>
              </MuiStack>
            )}
          </MuiStack>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

function CalendarConfig() {
  const [calendars, setCalendars] = useState<
    { id: string; summary: string; primary?: boolean }[] | null
  >(null);
  const [selected, setSelected] = useState<string>("primary");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const loadCalendars = async () => {
    const [listRes, tgtRes] = await Promise.all([
      send<{ id: string; summary: string; primary?: boolean }[]>({ type: "calendar.list" }),
      send<string>({ type: "calendar.getTarget" }),
    ]);
    if (listRes.ok) setCalendars(listRes.data);
    else setError(listRes.error);
    if (tgtRes.ok) setSelected(tgtRes.data);
  };

  useEffect(() => {
    void (async () => {
      const a = await send<AuthStatus>({ type: "auth.status" });
      const isConnected = a.ok && (a.data as AuthStatus).connected;
      setConnected(!!isConnected);
      const enRes = await send<boolean>({ type: "calendar.enabled.get" });
      const en = enRes.ok ? enRes.data : false;
      setEnabled(en);
      if (isConnected && en) await loadCalendars();
    })();
  }, []);

  if (!connected) return null;
  if (enabled === null) return null;

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    await send({ type: "calendar.enabled.set", enabled: next });
    if (next && !calendars) await loadCalendars();
  };

  const handleChange = async (id: string) => {
    setSelected(id);
    await send({ type: "calendar.setTarget", calendarId: id });
  };

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("config_calendar_section")}
        </MuiTypography>
        <MuiFormControlLabel
          control={
            <MuiCheckbox
              size="small"
              checked={enabled}
              onChange={(e) => void toggleEnabled(e.target.checked)}
            />
          }
          label={<MuiTypography variant="body2">{t("config_calendar_enable")}</MuiTypography>}
        />
        {enabled && (
          error ? (
            <MuiTypography variant="caption" color="text.secondary">
              {/insufficient|403/i.test(error)
                ? t("options_calendar_needs_reconnect")
                : error}
            </MuiTypography>
          ) : !calendars ? (
            <MuiTypography variant="caption" color="text.secondary">{t("status_loading")}</MuiTypography>
          ) : (
            <MuiStack spacing={1} sx={{ mt: 1 }}>
              <MuiTypography variant="caption" color="text.secondary">{t("options_target_calendar")}</MuiTypography>
              <MuiFormControl size="small" fullWidth>
                <MuiSelect
                  size="small"
                  value={selected}
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
            </MuiStack>
          )
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

function CatchUpConfig() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void send<boolean>({ type: "fetchOnResume.get" }).then((r) => {
      if (r.ok) setEnabled(r.data);
    });
  }, []);

  if (enabled === null) return null;

  const toggle = async (next: boolean) => {
    setEnabled(next);
    const r = await send({ type: "fetchOnResume.set", enabled: next });
    if (!r.ok) setEnabled(!next);
  };

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("options_fetch_on_resume")}
        </MuiTypography>
        <MuiFormControlLabel
          control={
            <MuiCheckbox
              size="small"
              checked={enabled}
              onChange={(e) => void toggle(e.target.checked)}
            />
          }
          label={<MuiTypography variant="body2">{t("options_fetch_on_resume_hint_v3")}</MuiTypography>}
        />
      </MuiCardContent>
    </MuiCard>
  );
}

function LogsConfig() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    const r = await send<string[]>({ type: "logs.get" });
    setLogs(r.ok ? r.data : [`error: ${r.ok ? "" : r.error}`]);
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
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <MuiTypography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {t("options_logs_title")}
          </MuiTypography>
          <MuiStack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
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
          <pre className="logs-pre popup-logs">
            {!logs
              ? t("status_loading")
              : logs.length === 0
                ? t("options_logs_empty")
                : logs.join("\n")}
          </pre>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

function GoogleConfig() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const refresh = async () => {
    const res = await send<AuthStatus>({ type: "auth.status" });
    if (res.ok) setStatus(res.data as AuthStatus);
  };
  useEffect(() => { void refresh(); }, []);

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("section_google")}
        </MuiTypography>
        {!status && <MuiTypography variant="caption" color="text.secondary">{t("status_loading")}</MuiTypography>}
        {status && !status.connected && (
          <MuiButton
            fullWidth
            variant="contained"
            onClick={() => { void send({ type: "auth.connect" }).then(() => refresh()); }}
          >
            {t("google_connect")}
          </MuiButton>
        )}
        {status?.connected && (
          <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <MuiTypography variant="caption" sx={{ color: "success.main" }}>{status.email}</MuiTypography>
            <MuiButton
              size="small"
              variant="outlined"
              onClick={() => { void send({ type: "auth.disconnect" }).then(() => refresh()); }}
            >
              {t("google_disconnect")}
            </MuiButton>
          </MuiStack>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

function VaultConfig() {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [ksefToken, setKsefToken] = useState("");
  const [contextNip, setContextNip] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const res = await send<VaultStatus>({ type: "vault.status" });
    if (res.ok) setVault(res.data);
  };
  useEffect(() => {
    void refresh();
    void chrome.storage.session.get("popup.setupDraft").then((r) => {
      const d = r["popup.setupDraft"] as { p?: string; t?: string; n?: string } | undefined;
      if (d) { if (d.p) setPassphrase(d.p); if (d.t) setKsefToken(d.t); if (d.n) setContextNip(d.n); }
    });
  }, []);
  useEffect(() => {
    void chrome.storage.session.set({ "popup.setupDraft": { p: passphrase, t: ksefToken, n: contextNip } });
  }, [passphrase, ksefToken, contextNip]);

  const setup = async () => {
    if (!passphrase || !ksefToken || !contextNip) return;
    setBusy(true); setError(null);
    const res = await send({ type: "vault.create", passphrase, ksefToken, contextNip });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    void chrome.storage.session.remove("popup.setupDraft");
    void refresh();
  };

  const handleTokenChange = (val: string) => {
    setKsefToken(val);
    const m = val.match(/\|nip-(\d{10})\|/);
    if (m) setContextNip(m[1]);
  };

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("section_ksef")}
        </MuiTypography>
        {!vault && <MuiTypography variant="caption" color="text.secondary">{t("status_loading")}</MuiTypography>}
        {vault && !vault.initialized && (
          <MuiStack spacing={1}>
            <MuiTextField
              size="small"
              type="password"
              fullWidth
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={t("placeholder_passphrase")}
            />
            <MuiTextField
              size="small"
              type="password"
              fullWidth
              value={ksefToken}
              onChange={(e) => handleTokenChange(e.target.value)}
              placeholder={t("placeholder_ksef_token")}
            />
            <MuiTextField
              size="small"
              type="text"
              fullWidth
              value={contextNip}
              onChange={(e) => setContextNip(e.target.value)}
              placeholder={t("placeholder_nip")}
              inputProps={{ pattern: "\\d{10}", inputMode: "numeric" }}
            />
            {contextNip && <MuiTypography variant="caption" color="text.secondary">{t("setup_nip_detected", contextNip)}</MuiTypography>}
            {error && <MuiAlert severity="error" sx={{ py: 0.5 }}>{error}</MuiAlert>}
            <MuiButton fullWidth variant="contained" onClick={setup} disabled={busy}>
              {busy ? t("button_setup_busy") : t("button_setup")}
            </MuiButton>
          </MuiStack>
        )}
        {vault?.initialized && vault.unlocked && (
          <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <MuiTypography variant="caption" sx={{ color: "success.main" }}>{t("vault_unlocked")}</MuiTypography>
            <MuiButton size="small" variant="outlined" onClick={() => {
              void send({ type: "vault.destroy" }).then(() => refresh());
            }}>{t("ksef_disconnect")}</MuiButton>
          </MuiStack>
        )}
        {vault?.initialized && !vault.unlocked && (
          <MuiStack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <MuiTypography variant="caption" color="text.secondary">{t("vault_locked")}</MuiTypography>
            <MuiButton size="small" variant="outlined" onClick={() => {
              void send({ type: "vault.destroy" }).then(() => refresh());
            }}>{t("ksef_disconnect")}</MuiButton>
          </MuiStack>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

function SyncConfig() {
  const [config, setConfig] = useState<AutoSyncConfig | null>(null);

  useEffect(() => {
    void send<AutoSyncConfig>({ type: "autoSync.getConfig" }).then((res) => {
      if (res.ok) setConfig(res.data);
    });
  }, []);

  const toggle = async (next: boolean) => {
    if (!config) return;
    setConfig({ ...config, enabled: next });
    const res = await send({ type: "autoSync.setEnabled", enabled: next });
    if (!res.ok) { setConfig({ ...config, enabled: !next }); return; }
    // Auto-enable "remember passphrase" when auto-sync is turned on
    if (next) {
      void send({ type: "vault.setRemember", enabled: true });
    }
  };

  if (!config) return null;

  return (
    <section className="config-section">
      <div className="config-row">
        <span className="small">{t("autosync_label", String(config.periodMinutes))}</span>
        <input type="checkbox" checked={config.enabled} onChange={(e) => void toggle(e.target.checked)} />
      </div>
    </section>
  );
}

function SyncIntervalSelect() {
  const [config, setConfig] = useState<AutoSyncConfig | null>(null);
  const [isTestEnv, setIsTestEnv] = useState(false);

  useEffect(() => {
    void send<AutoSyncConfig>({ type: "autoSync.getConfig" }).then((res) => {
      if (res.ok) setConfig(res.data);
    });
    void send({ type: "ksef.getEnvironment" }).then((res) => {
      if (res.ok) setIsTestEnv((res.data as { env: string }).env === "test");
    });
  }, []);

  const onChange = async (val: string) => {
    if (val === "off") {
      if (config) setConfig({ ...config, enabled: false });
      void send({ type: "autoSync.setEnabled", enabled: false });
      return;
    }
    const mins = parseInt(val, 10);
    if (config) setConfig({ ...config, enabled: true, periodMinutes: mins });
    await send({ type: "autoSync.setInterval", minutes: mins });
    await send({ type: "autoSync.setEnabled", enabled: true });
    // Auto-enable remember passphrase
    void send({ type: "vault.setRemember", enabled: true });
  };

  if (!config) return null;

  const currentValue = config.enabled ? String(config.periodMinutes) : "off";

  return (
    <select
      className="interval-select"
      value={currentValue}
      onChange={(e) => void onChange(e.target.value)}
    >
      <option value="off">{t("autosync_off")}</option>
      {isTestEnv && <option value="1">⟳ 1 min (test)</option>}
      <option value="30">⟳ 30 min</option>
      <option value="60">⟳ 1h</option>
      <option value="180">⟳ 3h</option>
      <option value="360">⟳ 6h</option>
    </select>
  );
}

function NotificationsConfig() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);

  useEffect(() => {
    void send<NotificationConfig>({ type: "notifications.getConfig" }).then((res) => {
      if (res.ok) setConfig(res.data);
    });
  }, []);

  const toggle = async (key: keyof NotificationConfig, next: boolean) => {
    if (!config) return;
    setConfig({ ...config, [key]: next });
    const res = await send({ type: "notifications.setConfig", config: { [key]: next } });
    if (!res.ok) setConfig({ ...config, [key]: !next });
  };

  if (!config) return null;

  const toggles: Array<{ key: keyof NotificationConfig; label: string }> = [
    { key: "syncResult", label: t("notif_toggle_sync_result") },
    { key: "newInvoices", label: t("notif_toggle_new_invoices") },
    { key: "syncError", label: t("notif_toggle_sync_error") },
    { key: "incomingInvoices", label: t("notif_toggle_incoming") },
  ];

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <MuiTypography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          {t("options_notifications")}
        </MuiTypography>
        <MuiStack>
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
              label={<MuiTypography variant="body2">{label}</MuiTypography>}
            />
          ))}
        </MuiStack>
      </MuiCardContent>
    </MuiCard>
  );
}

function ConnectionTestSection() {
  const [state, setState] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [result, setResult] = useState("");

  const test = async () => {
    setState("testing");
    const res = await send<{ invoiceCount: number; hasMore: boolean }>({ type: "ksef.testConnection" });
    if (!res.ok) { setState("error"); setResult(res.error); return; }
    setState("success");
    setResult(res.data.hasMore
      ? t("test_success_more", String(res.data.invoiceCount))
      : t("test_success", String(res.data.invoiceCount)));
  };

  return (
    <MuiCard variant="outlined" sx={{ mb: 1.5 }}>
      <MuiCardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        {state === "idle" && (
          <MuiButton fullWidth variant="outlined" onClick={test}>{t("button_test_connection")}</MuiButton>
        )}
        {state === "testing" && <MuiTypography variant="caption" color="text.secondary">{t("button_test_busy")}</MuiTypography>}
        {state === "success" && <MuiTypography variant="caption" sx={{ color: "success.main" }}>{result}</MuiTypography>}
        {state === "error" && <MuiAlert severity="error" sx={{ py: 0.5 }}>{result}</MuiAlert>}
      </MuiCardContent>
    </MuiCard>
  );
}

// =========================================================================
// Helpers
// =========================================================================

async function updateSyncCountdown(
  setPct: (pct: number | null) => void,
): Promise<void> {
  try {
    const alarm = await chrome.alarms.get("invo-sync.autoSync");
    if (!alarm?.scheduledTime) { setPct(null); return; }
    const now = Date.now();
    const period = (alarm.periodInMinutes ?? 30) * 60_000;
    const elapsed = now - (alarm.scheduledTime - period);
    const pct = Math.min(100, Math.max(0, (elapsed / period) * 100));
    setPct(pct);
  } catch {
    setPct(null);
  }
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("dashboard_just_now");
  if (minutes < 60) return t("dashboard_minutes_ago", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("dashboard_hours_ago", String(hours));
  return t("dashboard_days_ago", String(Math.floor(hours / 24)));
}

function CalendarButton({ invoice, ksefNumber }: { invoice: import("../ksef/fa3-parser").ParsedInvoice; ksefNumber: string }) {
  const [state, setState] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [eventLink, setEventLink] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      const en = await send<boolean>({ type: "calendar.enabled.get" });
      setEnabled(en.ok ? en.data : false);
      const existing = await send<{ eventId: string; htmlLink: string } | null>({
        type: "calendar.getEventForInvoice",
        ksefNumber,
      });
      if (existing.ok && existing.data) {
        setState("added");
        setEventLink(existing.data.htmlLink);
      }
    })();
  }, [ksefNumber]);

  if (enabled === null) return null;
  // Calendar feature master toggle — when off, hint the user on how to enable.
  if (!enabled) {
    return (
      <MuiButton
        variant="outlined"
        size="small"
        disabled
        startIcon={<span>📅</span>}
        title={t("config_calendar_enable")}
      >
        {t("invoice_calendar_add")}
      </MuiButton>
    );
  }

  const add = async () => {
    if (!invoice.dueDate) return;
    setState("adding");
    const summary = `${t("invoice_calendar_prefix")}: ${invoice.invoiceNumber} (${invoice.totals.gross.toLocaleString()} ${invoice.currency})`;
    const description = [
      `${t("invoice_seller")}: ${invoice.seller.name} (NIP ${invoice.seller.nip})`,
      `${t("invoice_buyer")}: ${invoice.buyer.name} (NIP ${invoice.buyer.nip})`,
      `${t("invoice_net")}: ${invoice.totals.net.toLocaleString()} ${invoice.currency}`,
      `VAT: ${invoice.totals.vat.toLocaleString()} ${invoice.currency}`,
      `${t("invoice_gross")}: ${invoice.totals.gross.toLocaleString()} ${invoice.currency}`,
      "",
      `KSeF: ${invoice.invoiceNumber}`,
    ].join("\n");
    const res = await send<{ id: string; htmlLink: string }>({
      type: "calendar.addInvoiceEvent",
      summary,
      description,
      date: invoice.dueDate,
      ksefNumber,
    });
    if (!res.ok) {
      setState("error");
      let msg = res.error;
      if (/insufficient.+scope|insufficientPermissions|403/i.test(msg)) {
        msg = "Missing Calendar permission — disconnect Google in Config and reconnect to grant it.";
      } else if (/has not been used|is disabled/i.test(msg)) {
        msg = "Google Calendar API is not enabled in the project.";
      }
      setErrorMsg(msg);
      return;
    }
    setState("added");
    setEventLink(res.data.htmlLink);
  };

  if (state === "added") {
    return (
      <MuiButton
        variant="outlined"
        size="small"
        color="success"
        startIcon={<span>✓</span>}
        component="a"
        href={eventLink}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("invoice_calendar_added")}
      </MuiButton>
    );
  }
  if (state === "error") {
    return (
      <MuiStack spacing={0.5} sx={{ alignItems: "flex-start" }}>
        <MuiButton
          variant="outlined"
          size="small"
          color="warning"
          startIcon={<span>⚠</span>}
          onClick={add}
        >
          {t("invoice_calendar_retry")}
        </MuiButton>
        <MuiTypography variant="caption" color="error">{errorMsg}</MuiTypography>
      </MuiStack>
    );
  }
  return (
    <MuiButton
      variant="outlined"
      size="small"
      onClick={add}
      disabled={state === "adding"}
      startIcon={state === "adding" ? <MuiCircularProgress size={14} /> : <span>📅</span>}
    >
      {state === "adding" ? t("invoice_calendar_adding") : t("invoice_calendar_add")}
    </MuiButton>
  );
}

async function downloadInvoiceXml(ksefNumber: string, invoiceNumber: string): Promise<void> {
  const res = await send<string>({ type: "invoice.fetchXml", ksefNumber });
  if (!res.ok) {
    alert(res.error);
    return;
  }
  const blob = new Blob([res.data], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${invoiceNumber.replace(/[/\\]/g, "_")}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function send<T = unknown>(msg: Message): Promise<Response<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res: Response<T> | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? "Unknown runtime error" });
        return;
      }
      if (!res) { resolve({ ok: false, error: "Empty response from service worker" }); return; }
      resolve(res);
    });
  });
}
