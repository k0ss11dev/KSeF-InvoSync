// SPDX-License-Identifier: GPL-3.0-or-later
// Devtools-only logger. No external sinks, no telemetry.
// Call `log("info", ...)` etc. — prefixes output with a fixed tag so
// extension noise is easy to filter in the devtools console.

type Level = "info" | "warn" | "error";

const PREFIX = "[invo-sync]";
const MAX_BUFFER_LINES = 300;

/** In-memory ring buffer of recent log lines. One per context (SW, popup, options). */
const buffer: string[] = [];

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function stringify(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function log(level: Level, ...args: unknown[]): void {
  const stamp = ts();
  const line = `${stamp} ${PREFIX} [${level}] ${args.map(stringify).join(" ")}`;
  buffer.push(line);
  if (buffer.length > MAX_BUFFER_LINES) {
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  }
  if (level === "error") {
    console.error(stamp, PREFIX, ...args);
  } else if (level === "warn") {
    console.warn(stamp, PREFIX, ...args);
  } else {
    console.log(stamp, PREFIX, ...args);
  }
}

/** Returns a snapshot of recent log lines (this context only). */
export function getLogBuffer(): string[] {
  return buffer.slice();
}

/** Clears this context's log buffer. */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

// Finding #7: error messages built from upstream HTTP response bodies can
// echo back bearer tokens or JWTs that were already leaked by the remote
// (for instance, a verbose 401 body that includes the rejected Authorization
// header). Scrub before the string reaches console, log buffer, or notification.
const BEARER_OR_JWT = /(bearer\s+|eyJ)[A-Za-z0-9_\-.]{20,}/gi;

/** Replace bearer tokens and JWT-shaped substrings with [REDACTED]. */
export function redactBearerTokens(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(BEARER_OR_JWT, "[REDACTED]");
}
