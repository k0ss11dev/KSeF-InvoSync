// SPDX-License-Identifier: GPL-3.0-or-later
// Material UI ThemeProvider that syncs with the popup's ☀/☾ header toggle via
// a MutationObserver on <html>[data-theme].
//
// Palette: Indigo primary (trust + thinking, standard for fintech) with an
// Emerald secondary / success accent (growth, money). Chosen over flat blue
// because "blue is becoming invisible" in 2026 SaaS — this pair stays modern
// while communicating reliability. Sources: 2026 SaaS color-trend write-ups
// summarised during the theme design review.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeProvider, createTheme, alpha } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";

function detectMode(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return "dark";
  if (attr === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function MuiProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"light" | "dark">(() => detectMode());

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(detectMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setMode(detectMode());
    mq.addEventListener("change", onChange);
    return () => {
      observer.disconnect();
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const theme = useMemo(() => {
    const isDark = mode === "dark";
    const primary = isDark ? "#818cf8" : "#4f46e5"; // indigo-400 / indigo-600
    const secondary = isDark ? "#34d399" : "#059669"; // emerald-400 / emerald-600
    const bgDefault = isDark ? "#0b1120" : "#f8fafc"; // slate-950 / slate-50
    const bgPaper = isDark ? "#1e293b" : "#ffffff"; // slate-800 / white — lighter dialog bg
    const divider = isDark ? "#1f2937" : "#e2e8f0";
    const textPrimary = isDark ? "#f1f5f9" : "#0f172a";
    const textSecondary = isDark ? "#94a3b8" : "#475569";

    return createTheme({
      palette: {
        mode,
        primary: { main: primary },
        secondary: { main: secondary },
        success: { main: secondary },
        background: { default: bgDefault, paper: bgPaper },
        divider,
        text: { primary: textPrimary, secondary: textSecondary },
      },
      typography: {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        fontSize: 13,
        h4: { fontWeight: 700 },
        h6: { fontWeight: 700 },
        subtitle1: { fontWeight: 600 },
        subtitle2: { fontWeight: 600 },
      },
      shape: { borderRadius: 8 },
      components: {
        MuiButton: {
          defaultProps: { disableElevation: true },
          styleOverrides: {
            root: { textTransform: "none", fontWeight: 500 },
            containedPrimary: {
              background: `linear-gradient(135deg, ${primary} 0%, ${alpha(primary, 0.8)} 100%)`,
              "&:hover": {
                background: `linear-gradient(135deg, ${alpha(primary, 0.95)} 0%, ${alpha(primary, 0.75)} 100%)`,
              },
            },
          },
        },
        MuiIconButton: {
          styleOverrides: {
            root: {
              borderRadius: 6,
              backgroundColor: isDark ? alpha("#ffffff", 0.04) : alpha("#0f172a", 0.04),
              transition: "background-color 120ms, transform 120ms",
              "&:hover": {
                backgroundColor: isDark ? alpha("#ffffff", 0.1) : alpha(primary, 0.1),
                transform: "translateY(-1px)",
              },
            },
            sizeSmall: { width: 30, height: 30 },
          },
        },
        MuiToggleButton: {
          styleOverrides: { root: { textTransform: "none" } },
        },
        MuiTab: {
          styleOverrides: {
            root: { textTransform: "none", fontWeight: 600 },
          },
        },
        MuiChip: {
          styleOverrides: {
            root: { fontWeight: 600 },
          },
        },
        MuiCard: {
          styleOverrides: {
            root: {
              borderRadius: 10,
              borderColor: divider,
            },
          },
        },
        MuiLinearProgress: {
          styleOverrides: {
            root: {
              backgroundColor: alpha(primary, 0.12),
            },
            bar: {
              background: `linear-gradient(90deg, ${primary}, ${secondary})`,
            },
          },
        },
        MuiAlert: {
          styleOverrides: {
            root: { borderRadius: 8 },
          },
        },
      },
    });
  }, [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      {children}
    </ThemeProvider>
  );
}
