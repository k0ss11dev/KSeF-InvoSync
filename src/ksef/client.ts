// SPDX-License-Identifier: GPL-3.0-or-later
// KSeF API client wrappers — non-auth endpoints. Each function takes an
// access token + parameters and returns typed data. Auth/refresh/terminate
// live in ./auth.ts and are the caller's responsibility.
//
// Sub-turn 1 of M1c: single-page invoice metadata query only. Pagination
// loop helper and other endpoints land in sub-turns 2 and 3.

import { redactBearerTokens } from "../shared/logger";
import type {
  InvoiceMetadata,
  InvoiceQueryFilters,
  InvoiceQueryResponse,
} from "./types";

export type QueryInvoiceMetadataOpts = {
  apiBaseUrl: string;
  accessToken: string;
  filters: InvoiceQueryFilters;
  /** Page index (0 = first page). Default 0. */
  pageOffset?: number;
  /** Page size (10..250 per the OpenAPI spec). Default 10. */
  pageSize?: number;
  /** "Asc" | "Desc". Default "Asc" — required for incremental-sync mode. */
  sortOrder?: "Asc" | "Desc";
};

/**
 * Single page of invoice metadata. Caller is responsible for pagination.
 *
 * KSeF docs note: for incremental sync use `dateType: "PermanentStorage"`
 * with `sortOrder: "Asc"` and walk pages while `hasMore === true`. If you
 * see `isTruncated === true`, narrow the date range using the last seen
 * `permanentStorageDate` and reset `pageOffset` to 0.
 */
export async function queryInvoiceMetadata(
  opts: QueryInvoiceMetadataOpts,
): Promise<InvoiceQueryResponse> {
  const baseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    pageOffset: String(opts.pageOffset ?? 0),
    pageSize: String(opts.pageSize ?? 10),
    sortOrder: opts.sortOrder ?? "Asc",
  });
  const url = `${baseUrl}/invoices/query/metadata?${params.toString()}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(opts.filters),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }

  return (await response.json()) as InvoiceQueryResponse;
}

// --- Pagination loop -----------------------------------------------------

export type QueryAllInvoiceMetadataOpts = Omit<
  QueryInvoiceMetadataOpts,
  "pageOffset"
> & {
  /**
   * Called after each page is fetched. Useful for the popup to show progress
   * during a long sync without having to poll. Synchronous — long callbacks
   * will slow the loop down.
   */
  onPage?: (info: {
    pageOffset: number;
    pageSize: number;
    pageCount: number;
    cumulative: number;
    hasMore: boolean;
  }) => void;
};

/**
 * Walks every page of `/invoices/query/metadata` until `hasMore === false`,
 * returns the flat array of all invoices. Caller picks the page size; the
 * default of 10 matches the OpenAPI default.
 *
 * KSeF docs note about `isTruncated`: when true, the result set hit the
 * 10,000-row server-side cap and you must narrow the date range and start
 * a new sync from the last seen `permanentStorageDate`. We surface this
 * as a thrown error in sub-turn 2; sub-turn 3 will add the date-range
 * narrowing strategy properly.
 */
export async function queryAllInvoiceMetadata(
  opts: QueryAllInvoiceMetadataOpts,
): Promise<InvoiceMetadata[]> {
  const pageSize = opts.pageSize ?? 10;
  const all: InvoiceMetadata[] = [];
  let pageOffset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await queryInvoiceMetadata({
      ...opts,
      pageOffset,
      pageSize,
    });

    all.push(...page.invoices);

    opts.onPage?.({
      pageOffset,
      pageSize,
      pageCount: page.invoices.length,
      cumulative: all.length,
      hasMore: page.hasMore,
    });

    if (page.isTruncated) {
      throw new Error(
        `invoice query result hit the server's 10,000-row cap (isTruncated=true). ` +
          `Date-range narrowing is not yet implemented (M1c sub-turn 3).`,
      );
    }

    if (!page.hasMore) {
      return all;
    }

    pageOffset++;
  }
}

/**
 * Fetch the full invoice content (FA3 XML bytes) by KSeF reference number.
 * Returns the raw XML string.
 */
export async function fetchInvoiceContent(opts: {
  apiBaseUrl: string;
  accessToken: string;
  ksefNumber: string;
}): Promise<string> {
  const baseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/invoices/ksef/${encodeURIComponent(opts.ksefNumber)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: "application/octet-stream",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `GET ${url} failed: ${resp.status} ${resp.statusText}${text ? ` — ${redactBearerTokens(text)}` : ""}`,
    );
  }
  return resp.text();
}

