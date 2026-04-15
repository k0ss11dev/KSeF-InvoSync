// SPDX-License-Identifier: GPL-3.0-or-later
// Google Calendar API v3 client — minimal: create an event on the
// primary calendar.

import { log } from "../shared/logger";

const DEFAULT_API_BASE = "https://www.googleapis.com";

export type CreateEventOpts = {
  accessToken: string;
  /** Calendar event title. */
  summary: string;
  /** Optional description (multi-line OK). */
  description?: string;
  /** YYYY-MM-DD — all-day event. */
  date: string;
  /** Optional location. */
  location?: string;
  /** Calendar ID — defaults to "primary". Can be any calendar the user owns. */
  calendarId?: string;
  /** Override the API base URL — used by tests. */
  apiBaseUrl?: string;
};

export type CalendarListEntry = {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  backgroundColor?: string;
};

export type CreatedEvent = {
  id: string;
  htmlLink: string;
};

/**
 * Create an all-day event on the user's primary Google Calendar.
 * Requires the `calendar.events` OAuth scope.
 */
export async function createCalendarEvent(
  opts: CreateEventOpts,
): Promise<CreatedEvent> {
  const baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const url = `${baseUrl}/calendar/v3/calendars/${calendarId}/events`;

  // For all-day events, end date is exclusive — set it to next day.
  const startDate = opts.date;
  const endDate = nextDay(opts.date);

  const body = {
    summary: opts.summary,
    description: opts.description ?? "",
    location: opts.location ?? "",
    start: { date: startDate },
    end: { date: endDate },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 * 24 * 3 }, // 3 days before
        { method: "popup", minutes: 60 * 24 }, // 1 day before
      ],
    },
  };

  log(
    "info",
    `Calendar: creating event "${opts.summary}" on calendar=${opts.calendarId ?? "primary"} date=${startDate}`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Calendar: create event failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const json = (await response.json()) as { id: string; htmlLink: string };
  log("info", `Calendar: event created id=${json.id}`);
  return { id: json.id, htmlLink: json.htmlLink };
}

/**
 * List the user's subscribed calendars. Requires `calendar.calendarlist.readonly`
 * (or broader) scope. Returns only calendars the user can write to
 * (accessRole: owner | writer).
 */
export async function listCalendars(
  accessToken: string,
  apiBaseUrl?: string,
): Promise<CalendarListEntry[]> {
  const baseUrl = (apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = `${baseUrl}/calendar/v3/users/me/calendarList?minAccessRole=writer`;

  log("info", "Calendar: listing calendars");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Calendar: list failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const json = (await response.json()) as { items?: CalendarListEntry[] };
  const items = json.items ?? [];
  log("info", `Calendar: ${items.length} calendar(s) listed`);
  return items;
}

function nextDay(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
