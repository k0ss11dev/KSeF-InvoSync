// SPDX-License-Identifier: GPL-3.0-or-later
// Local Node HTTP mock of the Google Sheets API v4. Mirrors the shape of
// tests/mocks/ksef-server.ts: listens on a random localhost port, returns
// shapes that match the real Sheets API, validates the Authorization
// header, and records the most recent create/append request bodies for
// tests to assert against.
//
// Endpoints:
//   POST /v4/spreadsheets                                  → create
//   POST /v4/spreadsheets/{id}/values/{range}:append       → append rows
//
// Both endpoints require Authorization: Bearer <accessToken> where the
// access token must have been registered via setAcceptedAccessToken()
// before the request — that lets tests simulate "the user authenticated
// with Google and then we used the resulting token".

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type MockGoogleSheetsServer = {
  /** Base URL the test should pass to the Sheets client. */
  url: string;
  close: () => Promise<void>;
  /** Allow this access token through Bearer auth checks. */
  setAcceptedAccessToken: (token: string) => void;
  /** Most recent /v4/spreadsheets create request body. */
  readonly lastCreateRequest: unknown;
  /** Most recent .../values/{range}:append request body. */
  readonly lastAppendRequest: unknown;
  /** Cumulative count of rows appended across all requests. */
  readonly totalRowsAppended: number;
  /** All spreadsheets created during this server's lifetime, keyed by id. */
  readonly createdSpreadsheets: ReadonlyMap<string, CreatedSpreadsheetMock>;
  /** Reset state between tests. */
  reset: () => void;
};

type TabMock = {
  tabName: string;
  sheetId: number;
  headerRow: string[];
  rows: Array<Array<unknown>>;
};

type CreatedSpreadsheetMock = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  /** Primary tab name (first tab). */
  tabName: string;
  sheetId: number;
  headerRow: string[];
  /** Rows in the primary tab (kept for backward compat with existing tests). */
  rows: Array<Array<unknown>>;
  /** All tabs keyed by name. */
  tabs: Map<string, TabMock>;
};

type State = {
  acceptedAccessTokens: Set<string>;
  lastCreateRequest: unknown;
  lastAppendRequest: unknown;
  totalRowsAppended: number;
  createdSpreadsheets: Map<string, CreatedSpreadsheetMock>;
};

export async function startMockGoogleSheetsServer(): Promise<MockGoogleSheetsServer> {
  const state: State = {
    acceptedAccessTokens: new Set(),
    lastCreateRequest: null,
    lastAppendRequest: null,
    totalRowsAppended: 0,
    createdSpreadsheets: new Map(),
  };

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, state).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: String(err) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock-google-sheets-server: failed to determine listen address");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    setAcceptedAccessToken(token) {
      state.acceptedAccessTokens.add(token);
    },
    get lastCreateRequest() {
      return state.lastCreateRequest;
    },
    get lastAppendRequest() {
      return state.lastAppendRequest;
    },
    get totalRowsAppended() {
      return state.totalRowsAppended;
    },
    get createdSpreadsheets() {
      return state.createdSpreadsheets;
    },
    reset() {
      state.acceptedAccessTokens.clear();
      state.lastCreateRequest = null;
      state.lastAppendRequest = null;
      state.totalRowsAppended = 0;
      state.createdSpreadsheets.clear();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
): Promise<void> {
  // Permissive CORS for the SW.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const path = (req.url ?? "").split("?")[0];

  // --- Bearer-token check (applies to every endpoint) -------------------
  const bearer = bearerFromHeaders(req);
  if (!bearer) {
    sendError(res, 401, "missing bearer token");
    return;
  }
  if (!state.acceptedAccessTokens.has(bearer)) {
    sendError(res, 401, "unknown access token");
    return;
  }

  // --- POST /v4/spreadsheets (create) -----------------------------------
  if (req.method === "POST" && path === "/v4/spreadsheets") {
    let body: {
      properties?: { title?: string };
      sheets?: Array<{
        properties?: { title?: string };
        data?: Array<{
          rowData?: Array<{
            values?: Array<{ userEnteredValue?: { stringValue?: string } }>;
          }>;
        }>;
      }>;
    };
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    state.lastCreateRequest = body;

    const spreadsheetId = `mock-ssid-${randomSuffix()}`;
    const firstTabName = body.sheets?.[0]?.properties?.title ?? "Sheet1";
    const firstHeaderRow =
      body.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values
        ?.map((v) => v.userEnteredValue?.stringValue ?? "") ?? [];
    const firstSheetId = Math.floor(Math.random() * 1_000_000_000);

    // Build tabs map from all sheets in the create request.
    const tabs = new Map<string, TabMock>();
    const responseSheets: Array<{
      properties: { sheetId: number; title: string; index: number; gridProperties: { frozenRowCount: number } };
    }> = [];

    for (let idx = 0; idx < (body.sheets?.length ?? 1); idx++) {
      const sheetSpec = body.sheets?.[idx];
      const tName = sheetSpec?.properties?.title ?? `Sheet${idx + 1}`;
      const tHeaders =
        sheetSpec?.data?.[0]?.rowData?.[0]?.values
          ?.map((v) => v.userEnteredValue?.stringValue ?? "") ?? [];
      const tSheetId = idx === 0 ? firstSheetId : Math.floor(Math.random() * 1_000_000_000);
      tabs.set(tName, {
        tabName: tName,
        sheetId: tSheetId,
        headerRow: tHeaders,
        rows: [tHeaders],
      });
      responseSheets.push({
        properties: {
          sheetId: tSheetId,
          title: tName,
          index: idx,
          gridProperties: { frozenRowCount: 1 },
        },
      });
    }

    const created: CreatedSpreadsheetMock = {
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      title: body.properties?.title ?? "Untitled",
      tabName: firstTabName,
      sheetId: firstSheetId,
      headerRow: firstHeaderRow,
      rows: tabs.get(firstTabName)?.rows ?? [firstHeaderRow],
      tabs,
    };
    state.createdSpreadsheets.set(spreadsheetId, created);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        spreadsheetId,
        spreadsheetUrl: created.spreadsheetUrl,
        properties: { title: created.title },
        sheets: responseSheets.length > 0 ? responseSheets : [
          {
            properties: {
              sheetId: firstSheetId,
              title: firstTabName,
              index: 0,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        ],
      }),
    );
    return;
  }

  // --- GET /drive/v3/files (list app-created spreadsheets) --------------
  if (req.method === "GET" && path === "/drive/v3/files") {
    // The mock returns spreadsheets we previously created via /v4/spreadsheets,
    // sorted by mock insertion order in reverse (newest first), to match
    // Drive's `orderBy=modifiedTime desc`.
    const spreadsheets = Array.from(state.createdSpreadsheets.values())
      .reverse()
      .map((s) => ({
        id: s.spreadsheetId,
        name: s.title,
        // Mock modifiedTime is "now" (good enough for tests).
        modifiedTime: new Date().toISOString(),
        webViewLink: s.spreadsheetUrl,
      }));
    res.statusCode = 200;
    res.end(JSON.stringify({ files: spreadsheets }));
    return;
  }

  // --- POST /v4/spreadsheets/{id}/values/{range}:append (append) --------
  // The path looks like:
  //   /v4/spreadsheets/<id>/values/<range-encoded>:append
  const appendMatch = path.match(/^\/v4\/spreadsheets\/([^/]+)\/values\/([^/]+):append$/);
  if (req.method === "POST" && appendMatch) {
    const spreadsheetId = decodeURIComponent(appendMatch[1]);
    const range = decodeURIComponent(appendMatch[2]);

    const created = state.createdSpreadsheets.get(spreadsheetId);
    if (!created) {
      sendError(res, 404, `unknown spreadsheet ${spreadsheetId}`);
      return;
    }

    let body: { values?: Array<Array<unknown>> };
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendError(res, 400, "invalid json", String(err));
      return;
    }

    const rows = body.values ?? [];
    state.lastAppendRequest = body;
    state.totalRowsAppended += rows.length;

    // Store rows in the correct tab (range is the tab name).
    // Note: created.rows IS the same array as tabs.get(primaryTabName).rows
    // (they share a reference from the create handler), so pushing to the
    // tab automatically updates created.rows for the primary tab.
    const tab = created.tabs.get(range);
    if (tab) {
      tab.rows.push(...rows);
    } else {
      // Unknown tab — fall back to the legacy flat array.
      created.rows.push(...rows);
    }

    const targetRows = tab?.rows ?? created.rows;
    const updatedRange = `${range}!A${targetRows.length - rows.length + 1}:Z${targetRows.length}`;
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        spreadsheetId,
        tableRange: range,
        updates: {
          spreadsheetId,
          updatedRange,
          updatedRows: rows.length,
          updatedColumns: rows[0]?.length ?? 0,
          updatedCells: rows.length * (rows[0]?.length ?? 0),
        },
      }),
    );
    return;
  }

  // --- POST /v4/spreadsheets/{id}:batchUpdate (charts etc.) ---------------
  const batchMatch = path.match(/^\/v4\/spreadsheets\/([^/]+):batchUpdate$/);
  if (req.method === "POST" && batchMatch) {
    // Accept and ignore — the mock doesn't render charts, but the API call
    // should succeed so sync.ts doesn't throw.
    await readBody(req);
    res.statusCode = 200;
    res.end(JSON.stringify({ spreadsheetId: decodeURIComponent(batchMatch[1]), replies: [] }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "not found", path } }));
}

// --- Helpers --------------------------------------------------------------

function bearerFromHeaders(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? req.headers.Authorization;
  if (!auth || typeof auth !== "string") return null;
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim() || null;
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  detail?: string,
): void {
  res.statusCode = status;
  res.end(
    JSON.stringify({
      error: { code: status, message, ...(detail ? { detail } : {}) },
    }),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12);
}
