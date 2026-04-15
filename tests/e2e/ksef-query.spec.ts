// SPDX-License-Identifier: GPL-3.0-or-later
// M1c sub-turn 1: single-page invoice metadata query against the mock.
// M1c sub-turn 2: pagination loop walks every page, default + custom sizes.
// M1c sub-turn 3 will add the edge cases (expired token, empty result,
// isTruncated, etc.).

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";

test.describe("M1c sub-turn 1 — invoice metadata query (single page)", () => {
  let mock: MockKsefServer;

  test.beforeAll(async () => {
    mock = await startMockKsefServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(() => {
    mock.reset();
  });

  test("auth → query first page → returns 10 invoices with hasMore=true", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;

      const session = await auth.authenticateWithKsefToken({
        apiBaseUrl,
        ksefToken: "fake-test-token",
        contextIdentifier: { type: "Nip", value: "0000000000" },
      });

      return client.queryInvoiceMetadata({
        apiBaseUrl,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject1",
          dateRange: {
            dateType: "PermanentStorage",
            from: "2025-01-01T00:00:00Z",
            to: "2026-12-31T23:59:59Z",
          },
        },
        pageSize: 10,
        sortOrder: "Asc",
      });
    }, mock.url);

    expect(result.invoices.length).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.isTruncated).toBe(false);
    // Spot-check the first invoice has the rich metadata shape we declared.
    const first = result.invoices[0];
    expect(first.ksefNumber).toMatch(/^5555555555-/);
    expect(first.invoiceNumber).toMatch(/^FA\/MOCK\//);
    expect(first.seller?.nip).toBe("5555555555");
    expect(first.currency).toBe("PLN");
  });
});

test.describe("M1c sub-turn 2 — invoice metadata query (pagination loop)", () => {
  let mock: MockKsefServer;

  test.beforeAll(async () => {
    mock = await startMockKsefServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(() => {
    mock.reset();
  });

  test("queryAllInvoiceMetadata walks 3 pages of 10 and returns all 30 invoices", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;

      const session = await auth.authenticateWithKsefToken({
        apiBaseUrl,
        ksefToken: "fake-test-token",
        contextIdentifier: { type: "Nip", value: "0000000000" },
      });

      const cumulativeAfterEachPage: number[] = [];
      const all = await client.queryAllInvoiceMetadata({
        apiBaseUrl,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject1",
          dateRange: {
            dateType: "PermanentStorage",
            from: "2025-01-01T00:00:00Z",
            to: "2026-12-31T23:59:59Z",
          },
        },
        pageSize: 10,
        onPage: (info) => {
          cumulativeAfterEachPage.push(info.cumulative);
        },
      });

      return {
        totalCount: all.length,
        cumulativeAfterEachPage,
        firstKsefNumber: all[0]?.ksefNumber,
        lastKsefNumber: all[all.length - 1]?.ksefNumber,
      };
    }, mock.url);

    expect(result.totalCount).toBe(30);
    // Three pages of 10: cumulative should be [10, 20, 30].
    expect(result.cumulativeAfterEachPage).toEqual([10, 20, 30]);
    // The dataset is anchored on 2026-04-01 with one invoice per day in
    // ascending order, so the first ksefNumber should sort before the last.
    expect(result.firstKsefNumber).not.toBe(result.lastKsefNumber);
  });

  test("queryAllInvoiceMetadata respects pageSize=15 → 2 pages → 30 invoices", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;

      const session = await auth.authenticateWithKsefToken({
        apiBaseUrl,
        ksefToken: "fake-test-token",
        contextIdentifier: { type: "Nip", value: "0000000000" },
      });

      const pageSizes: number[] = [];
      const all = await client.queryAllInvoiceMetadata({
        apiBaseUrl,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject1",
          dateRange: {
            dateType: "PermanentStorage",
            from: "2025-01-01T00:00:00Z",
            to: "2026-12-31T23:59:59Z",
          },
        },
        pageSize: 15,
        onPage: (info) => {
          pageSizes.push(info.pageCount);
        },
      });

      return { totalCount: all.length, pageSizes };
    }, mock.url);

    expect(result.totalCount).toBe(30);
    // 30 / 15 = 2 pages, both full.
    expect(result.pageSizes).toEqual([15, 15]);
  });
});

test.describe("M1c sub-turn 3 — invoice metadata query (edge cases)", () => {
  let mock: MockKsefServer;

  test.beforeAll(async () => {
    mock = await startMockKsefServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(() => {
    mock.reset();
  });

  test("queryInvoiceMetadata surfaces 401 with a meaningful error on bogus access token", async ({
    serviceWorker,
  }) => {
    const errorMessage = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;
      try {
        await client.queryInvoiceMetadata({
          apiBaseUrl,
          accessToken: "totally-bogus-access-token",
          filters: {
            subjectType: "Subject1",
            dateRange: {
              dateType: "PermanentStorage",
              from: "2025-01-01T00:00:00Z",
              to: "2026-12-31T23:59:59Z",
            },
          },
        });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }, mock.url);
    expect(errorMessage).not.toBeNull();
    expect(errorMessage).toMatch(/401/);
    expect(errorMessage).toMatch(/unknown access token|missing bearer token/);
  });

  test("queryAllInvoiceMetadata returns [] cleanly when the date range matches no invoices", async ({
    serviceWorker,
  }) => {
    const count = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;

      const session = await auth.authenticateWithKsefToken({
        apiBaseUrl,
        ksefToken: "fake-test-token",
        contextIdentifier: { type: "Nip", value: "0000000000" },
      });

      // The mock dataset is anchored on 2026-04-01..2026-04-30. A 2030 range
      // hits zero rows.
      const all = await client.queryAllInvoiceMetadata({
        apiBaseUrl,
        accessToken: session.accessToken.token,
        filters: {
          subjectType: "Subject1",
          dateRange: {
            dateType: "PermanentStorage",
            from: "2030-01-01T00:00:00Z",
            to: "2030-12-31T23:59:59Z",
          },
        },
        pageSize: 10,
      });

      return all.length;
    }, mock.url);

    expect(count).toBe(0);
  });

  test("queryAllInvoiceMetadata throws on isTruncated=true (mock force-truncate)", async ({
    serviceWorker,
  }) => {
    mock.forceTruncateNextQuery();

    const errorMessage = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      const client = (
        globalThis as unknown as {
          __ksefClientForTests: typeof import("../../src/ksef/client");
        }
      ).__ksefClientForTests;

      const session = await auth.authenticateWithKsefToken({
        apiBaseUrl,
        ksefToken: "fake-test-token",
        contextIdentifier: { type: "Nip", value: "0000000000" },
      });

      try {
        await client.queryAllInvoiceMetadata({
          apiBaseUrl,
          accessToken: session.accessToken.token,
          filters: {
            subjectType: "Subject1",
            dateRange: {
              dateType: "PermanentStorage",
              from: "2025-01-01T00:00:00Z",
              to: "2026-12-31T23:59:59Z",
            },
          },
          pageSize: 10,
        });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }, mock.url);

    expect(errorMessage).not.toBeNull();
    expect(errorMessage).toMatch(/truncated|isTruncated/i);
  });
});
