// SPDX-License-Identifier: GPL-3.0-or-later
// M1d sub-turn 1: end-to-end sync orchestrator against the mock.
// Sets up vault → stores KSeF token + context NIP → calls runSync →
// asserts the row count and result shape. UI tests are sub-turns 2/3.

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";

const PASSPHRASE = "correct horse battery staple";
const KSEF_TOKEN = "fake-ksef-test-token-AAAA-BBBB";
const CONTEXT_NIP = "5555555555";

test.describe("M1d sub-turn 1 — sync orchestrator (vault → auth → query → count)", () => {
  let mock: MockKsefServer;

  test.beforeAll(async () => {
    mock = await startMockKsefServer();
  });

  test.afterAll(async () => {
    await mock?.close();
  });

  test.beforeEach(async () => {
    mock.reset();
  });

  test("happy path: vault setup → runSync → returns 30 invoices", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ apiBaseUrl, passphrase, token, nip }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(token);
        await v.setContextNip(nip);

        // The mock dataset is anchored at 2026-04-01..2026-04-30. Cover it
        // explicitly so this test isn't dependent on "today's date".
        return sync.runSync({
          apiBaseUrl,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
      },
      {
        apiBaseUrl: mock.url,
        passphrase: PASSPHRASE,
        token: KSEF_TOKEN,
        nip: CONTEXT_NIP,
      },
    );

    expect(result.totalCount).toBe(30);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.fromDate).toBe("2026-03-01T00:00:00Z");
    expect(result.toDate).toBe("2026-05-01T00:00:00Z");
    expect(result.sample.length).toBe(5);
    expect(result.sample[0].seller?.nip).toBe("5555555555");
  });

  test("happy path: encrypted KSeF token in vault flows correctly to /auth/ksef-token", async ({
    serviceWorker,
  }) => {
    await serviceWorker.evaluate(
      async ({ apiBaseUrl, passphrase, token, nip }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(token);
        await v.setContextNip(nip);

        await sync.runSync({
          apiBaseUrl,
          fromDate: "2026-03-01T00:00:00Z",
          toDate: "2026-05-01T00:00:00Z",
        });
      },
      {
        apiBaseUrl: mock.url,
        passphrase: PASSPHRASE,
        token: KSEF_TOKEN,
        nip: CONTEXT_NIP,
      },
    );

    // Verify the round-trip end-to-end: the mock decrypted the envelope it
    // received and the plaintext starts with the exact KSeF token we put in
    // the vault. Proves the vault → orchestrator → auth → wire format chain
    // is intact.
    expect(mock.lastDecryptedTokenEnvelope).not.toBeNull();
    expect(mock.lastDecryptedTokenEnvelope!.startsWith(`${KSEF_TOKEN}|`)).toBe(true);
  });

  test("fails meaningfully when the vault is locked", async ({ serviceWorker }) => {
    const errorMessage = await serviceWorker.evaluate(
      async ({ apiBaseUrl, passphrase, token, nip }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        await v.setKsefToken(token);
        await v.setContextNip(nip);
        v.lock();
        v.__testing.forgetUnlockedKey();

        try {
          await sync.runSync({ apiBaseUrl });
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      },
      {
        apiBaseUrl: mock.url,
        passphrase: PASSPHRASE,
        token: KSEF_TOKEN,
        nip: CONTEXT_NIP,
      },
    );
    expect(errorMessage).toMatch(/locked/i);
  });

  test("fails meaningfully when the KSeF token is missing from the vault", async ({
    serviceWorker,
  }) => {
    const errorMessage = await serviceWorker.evaluate(
      async ({ apiBaseUrl, passphrase, nip }) => {
        const v = (
          globalThis as unknown as {
            __vaultForTests: typeof import("../../src/storage/vault");
          }
        ).__vaultForTests;
        const sync = (
          globalThis as unknown as {
            __ksefSyncForTests: typeof import("../../src/ksef/sync");
          }
        ).__ksefSyncForTests;

        await v.destroy();
        await v.create(passphrase);
        // Note: NO setKsefToken — only the NIP is stored.
        await v.setContextNip(nip);

        try {
          await sync.runSync({ apiBaseUrl });
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      },
      {
        apiBaseUrl: mock.url,
        passphrase: PASSPHRASE,
        nip: CONTEXT_NIP,
      },
    );
    expect(errorMessage).toMatch(/no ksef token/i);
  });
});
