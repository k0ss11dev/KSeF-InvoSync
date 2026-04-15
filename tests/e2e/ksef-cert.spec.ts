// SPDX-License-Identifier: GPL-3.0-or-later
// Tier 3 e2e: exercise the KSeF cert-fetch + key-import path against the
// local mock server, end-to-end through the extension's service worker.
// Also verifies the wire format of the encrypted token envelope by
// asking the mock server to decrypt what the extension sent.

import { expect, test } from "./fixtures/extension";
import {
  startMockKsefServer,
  type MockKsefServer,
} from "../mocks/ksef-server";

const SAMPLE_KSEF_TOKEN = "abc123-XYZ-test-ksef-token-deadbeef";

test.describe("M1b — fetch cert + import key + encrypt envelope", () => {
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

  test("fetches public-key cert from mock and imports as RSA-OAEP key", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async (apiBaseUrl) => {
      const ksef = (
        globalThis as unknown as { __ksefForTests: typeof import("../../src/ksef/cert") }
      ).__ksefForTests;
      const imported = await ksef.fetchKsefTokenEncryptionKey(apiBaseUrl);
      return {
        algorithmName: imported.publicKey.algorithm.name,
        // RsaHashedKeyAlgorithm has a `hash` field with `name`
        hashName: (
          imported.publicKey.algorithm as unknown as { hash: { name: string } }
        ).hash.name,
        usages: imported.publicKey.usages,
        validFromMs: imported.validFrom.getTime(),
        validToMs: imported.validTo.getTime(),
      };
    }, mock.url);

    expect(result.algorithmName).toBe("RSA-OAEP");
    expect(result.hashName).toBe("SHA-256");
    expect(result.usages).toContain("encrypt");
    expect(result.validFromMs).toBeLessThanOrEqual(Date.now());
    expect(result.validToMs).toBeGreaterThan(Date.now());
  });

  test("encrypts envelope and mock server decrypts to {token}|{timestampMs}", async ({
    serviceWorker,
  }) => {
    // Step 1: SW fetches the cert and encrypts an envelope, then POSTs to
    // /auth/ksef-token. The mock server records the decrypted plaintext.
    await serviceWorker.evaluate(
      async ({ apiBaseUrl, ksefToken }) => {
        const ksef = (
          globalThis as unknown as { __ksefForTests: typeof import("../../src/ksef/cert") }
        ).__ksefForTests;
        const imported = await ksef.fetchKsefTokenEncryptionKey(apiBaseUrl);

        // Get a challenge.
        const challengeRes = await fetch(`${apiBaseUrl}/auth/challenge`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        const challenge = (await challengeRes.json()) as {
          challenge: string;
          timestampMs: number;
        };

        // Encrypt and submit.
        const encrypted = await ksef.encryptKsefTokenEnvelope(
          imported.publicKey,
          ksefToken,
          challenge.timestampMs,
        );

        const submitRes = await fetch(`${apiBaseUrl}/auth/ksef-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: challenge.challenge,
            contextIdentifier: { type: "Nip", value: "0000000000" },
            encryptedToken: encrypted,
          }),
        });
        if (!submitRes.ok) {
          throw new Error(`submit failed: ${submitRes.status}`);
        }
        return challenge.timestampMs;
      },
      { apiBaseUrl: mock.url, ksefToken: SAMPLE_KSEF_TOKEN },
    );

    // Step 2: assert the mock server saw the right plaintext.
    expect(mock.lastDecryptedTokenEnvelope).not.toBeNull();
    const envelope = mock.lastDecryptedTokenEnvelope!;
    expect(envelope.startsWith(`${SAMPLE_KSEF_TOKEN}|`)).toBe(true);

    // The right-hand side of the | is the timestamp; check it parses as a
    // recent unix-ms integer (within ±10s of now).
    const timestampStr = envelope.split("|")[1];
    expect(timestampStr).toMatch(/^\d+$/);
    const tsNum = Number(timestampStr);
    expect(Math.abs(Date.now() - tsNum)).toBeLessThan(10_000);
  });
});
