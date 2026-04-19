// SPDX-License-Identifier: GPL-3.0-or-later
// Google Drive API v3 client — narrowly scoped to "list spreadsheets the
// user has previously created via this extension" so the popup can offer a
// picker of existing target sheets.
//
// Permission scope: `https://www.googleapis.com/auth/drive.file` (already
// requested in the M0 OAuth flow). With this scope:
//   - We CAN list/read files this extension has created
//   - We CANNOT see the user's other personal spreadsheets
//
// To support picking arbitrary user-owned files we'd need:
//   - `drive.metadata.readonly` — broader scope, triggers Google's
//     verification review at Web Store submission time
//   - OR the Google Picker API — Google-hosted file dialog. Requires
//     loading external JS which our strict CSP currently blocks.
//
// For v1 the app-created-only constraint is the right tradeoff: it solves
// the immediate "new file each sync" problem (every prior auto-created
// sheet shows up in the picker) without expanding the OAuth surface area.

import { log, redactBearerTokens } from "../shared/logger";

const DEFAULT_API_BASE = "https://www.googleapis.com";

export type SpreadsheetSummary = {
  id: string;
  name: string;
  /** ISO 8601 timestamp from Drive's `modifiedTime`. */
  modifiedTime: string;
  /** Web view URL — direct link the user can open. */
  webViewLink: string;
};

export type ListSpreadsheetsOpts = {
  accessToken: string;
  /** Override the API base URL — used by e2e tests to point at the local mock. */
  apiBaseUrl?: string;
  /** Max results to return. Default: 50, Drive's hard cap is 1000. */
  pageSize?: number;
};

/**
 * List spreadsheets this extension has created (per `drive.file` scope),
 * sorted by `modifiedTime` descending so the most recent target sheets
 * appear first in the picker.
 *
 * Uses Drive API v3 `files.list`:
 *   GET /drive/v3/files
 *     ?q=mimeType='application/vnd.google-apps.spreadsheet' and trashed=false
 *     &orderBy=modifiedTime desc
 *     &pageSize=N
 *     &fields=files(id,name,modifiedTime,webViewLink)
 *     &spaces=drive
 */
export async function listAppCreatedSpreadsheets(
  opts: ListSpreadsheetsOpts,
): Promise<SpreadsheetSummary[]> {
  const baseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    orderBy: "modifiedTime desc",
    pageSize: String(opts.pageSize ?? 50),
    fields: "files(id,name,modifiedTime,webViewLink)",
    spaces: "drive",
  });
  const url = `${baseUrl}/drive/v3/files?${params.toString()}`;

  log("info", "Drive: listing app-created spreadsheets");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log("warn", `Drive: list failed ${response.status} ${response.statusText} — ${text}`);
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    files?: Array<{
      id: string;
      name: string;
      modifiedTime: string;
      webViewLink: string;
    }>;
  };
  const files = json.files ?? [];
  log("info", `Drive: ${files.length} app-created spreadsheet(s) found`);

  return files.map((f) => ({
    id: f.id,
    name: f.name,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
  }));
}
