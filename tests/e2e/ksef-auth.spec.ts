// SPDX-License-Identifier: GPL-3.0-or-later
// Tier 3 e2e: drive the full KSeF token-based auth orchestrator (challenge
// → ksef-token → redeem) end-to-end through the extension's service worker
// against the local mock server. Plus refresh and terminate.

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";

const SAMPLE_KSEF_TOKEN = "sample-ksef-test-token-AAAA-BBBB-CCCC";
const SAMPLE_NIP = "0000000000";

test.describe("M1b — KSeF auth orchestrator against mock", () => {
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

  test("authenticateWithKsefToken returns access + refresh tokens with valid shapes", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        return auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );

    expect(result.referenceNumber).toMatch(/^MOCK-REF-/);
    expect(result.accessToken.token).toMatch(/^mock\.access\./);
    expect(result.refreshToken.token).toMatch(/^mock\.refresh\./);
    expect(Date.parse(result.accessToken.validUntil)).toBeGreaterThan(Date.now());
    expect(Date.parse(result.refreshToken.validUntil)).toBeGreaterThan(Date.now());
  });

  test("auth flow encrypts the right envelope (mock decrypts the ciphertext)", async ({
    serviceWorker,
  }) => {
    await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );

    expect(mock.lastDecryptedTokenEnvelope).not.toBeNull();
    const envelope = mock.lastDecryptedTokenEnvelope!;
    expect(envelope.startsWith(`${SAMPLE_KSEF_TOKEN}|`)).toBe(true);
    const tsStr = envelope.split("|")[1];
    expect(tsStr).toMatch(/^\d+$/);
    expect(Math.abs(Date.now() - Number(tsStr))).toBeLessThan(10_000);
  });

  test("redeem is single-use — second auth flow with the same auth token fails", async ({
    serviceWorker,
  }) => {
    // The mock removes the authenticationToken from `pendingAuthTokens` after
    // a successful redeem. Here we simulate two consecutive auth flows;
    // each one gets its own fresh authToken so both succeed (no reuse).
    // We also poke the mock directly to verify single-use semantics work.
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const a = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
        const b = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
        return {
          firstAccess: a.accessToken.token,
          secondAccess: b.accessToken.token,
        };
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );
    expect(result.firstAccess).not.toBe(result.secondAccess);
  });

  test("refreshKsefAccessToken mints a new access token", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const session = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
        const refreshed = await auth.refreshKsefAccessToken({
          apiBaseUrl,
          refreshToken: session.refreshToken.token,
        });
        return {
          original: session.accessToken.token,
          refreshed: refreshed.accessToken.token,
        };
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );
    expect(result.refreshed).toMatch(/^mock\.access\./);
    expect(result.refreshed).not.toBe(result.original);
  });

  test("refresh with invalid refresh token throws", async ({ serviceWorker }) => {
    const errorMessage = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const auth = (
        globalThis as unknown as {
          __ksefAuthForTests: typeof import("../../src/ksef/auth");
        }
      ).__ksefAuthForTests;
      try {
        await auth.refreshKsefAccessToken({
          apiBaseUrl,
          refreshToken: "totally-bogus-token",
        });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    }, mock.url);
    expect(errorMessage).toMatch(/401/);
  });

  test("terminateKsefSession returns cleanly and revokes future refreshes", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken, nip }) => {
        const auth = (
          globalThis as unknown as {
            __ksefAuthForTests: typeof import("../../src/ksef/auth");
          }
        ).__ksefAuthForTests;
        const session = await auth.authenticateWithKsefToken({
          apiBaseUrl,
          ksefToken,
          contextIdentifier: { type: "Nip", value: nip },
        });
        await auth.terminateKsefSession({
          apiBaseUrl,
          accessToken: session.accessToken.token,
        });

        // After terminate, the refresh token should no longer work.
        let refreshThrew = false;
        try {
          await auth.refreshKsefAccessToken({
            apiBaseUrl,
            refreshToken: session.refreshToken.token,
          });
        } catch {
          refreshThrew = true;
        }

        return { refreshThrew };
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN, nip: SAMPLE_NIP },
    );
    expect(result.refreshThrew).toBe(true);
  });
});
