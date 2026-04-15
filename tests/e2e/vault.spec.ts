// SPDX-License-Identifier: GPL-3.0-or-later
// Tier 2/3 e2e: exercise the vault end-to-end inside the service worker.
// We can't import vault.ts directly into the test process because it uses
// chrome.storage.local — instead we run all vault calls inside the SW via
// serviceWorker.evaluate(), which is exactly how the real popup will use it.
//
// The SW imports vault as a side-effect of being bundled, but we don't have
// a direct handle to it from the test context. Instead we exercise the
// chrome.storage.local round-trip via the SW's globalThis. To get a vault
// handle, we use a tiny inline test bridge: the SW exposes the vault module
// on globalThis.__vaultForTests when running in a non-production build.
// (That hook is added in this turn — see src/background/service-worker.ts.)

import { expect, test } from "./fixtures/extension";

const PASSPHRASE = "correct horse battery staple";
const WRONG_PASSPHRASE = "wrong horse battery staple";
const SAMPLE_TOKEN = "fake-ksef-test-token-AAAA-BBBB-CCCC-DDDD";

type VaultBridge = {
  isInitialized(): Promise<boolean>;
  isUnlocked(): boolean;
  create(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<boolean>;
  lock(): void;
  destroy(): Promise<void>;
  setKsefToken(token: string): Promise<void>;
  getKsefToken(): Promise<string | null>;
  clearKsefToken(): Promise<void>;
  __testing: { forgetUnlockedKey(): void };
};

declare global {
  // Set by service-worker.ts in dev/test builds.
  // eslint-disable-next-line no-var
  var __vaultForTests: VaultBridge | undefined;
}

test.describe("vault e2e (chrome.storage.local round-trip)", () => {
  test.beforeEach(async ({ serviceWorker }) => {
    // Ensure each test starts from a clean vault state.
    await serviceWorker.evaluate(async () => {
      await globalThis.__vaultForTests!.destroy();
    });
  });

  test("create → setKsefToken → getKsefToken round-trips", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(
      async ({ passphrase, token }) => {
        const v = globalThis.__vaultForTests!;
        await v.create(passphrase);
        await v.setKsefToken(token);
        return v.getKsefToken();
      },
      { passphrase: PASSPHRASE, token: SAMPLE_TOKEN },
    );
    expect(result).toBe(SAMPLE_TOKEN);
  });

  test("unlock with correct passphrase succeeds and exposes the token", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ passphrase, token }) => {
        const v = globalThis.__vaultForTests!;
        await v.create(passphrase);
        await v.setKsefToken(token);
        v.lock();
        v.__testing.forgetUnlockedKey();

        const unlockedOk = await v.unlock(passphrase);
        const retrieved = await v.getKsefToken();
        return { unlockedOk, retrieved };
      },
      { passphrase: PASSPHRASE, token: SAMPLE_TOKEN },
    );
    expect(result.unlockedOk).toBe(true);
    expect(result.retrieved).toBe(SAMPLE_TOKEN);
  });

  test("unlock with wrong passphrase returns false and leaves vault locked", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(
      async ({ correct, wrong, token }) => {
        const v = globalThis.__vaultForTests!;
        await v.create(correct);
        await v.setKsefToken(token);
        v.lock();
        v.__testing.forgetUnlockedKey();

        const unlockedOk = await v.unlock(wrong);
        const stillLocked = !v.isUnlocked();
        let getThrew = false;
        try {
          await v.getKsefToken();
        } catch {
          getThrew = true;
        }
        return { unlockedOk, stillLocked, getThrew };
      },
      { correct: PASSPHRASE, wrong: WRONG_PASSPHRASE, token: SAMPLE_TOKEN },
    );
    expect(result.unlockedOk).toBe(false);
    expect(result.stillLocked).toBe(true);
    expect(result.getThrew).toBe(true);
  });

  test("getEntry on locked vault throws", async ({ serviceWorker }) => {
    const threw = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);
      await v.setKsefToken(token);
      v.lock();
      v.__testing.forgetUnlockedKey();

      try {
        await v.getKsefToken();
        return false;
      } catch {
        return true;
      }
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });
    expect(threw).toBe(true);
  });

  test("destroy clears storage and locks", async ({ serviceWorker }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);
      await v.setKsefToken(token);
      await v.destroy();

      const initialized = await v.isInitialized();
      const unlocked = v.isUnlocked();
      return { initialized, unlocked };
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });

    expect(result.initialized).toBe(false);
    expect(result.unlocked).toBe(false);
  });

  test("clearKsefToken removes the entry but vault stays unlocked", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);
      await v.setKsefToken(token);
      await v.clearKsefToken();
      const after = await v.getKsefToken();
      return { after, unlocked: v.isUnlocked() };
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });

    expect(result.after).toBeNull();
    expect(result.unlocked).toBe(true);
  });
});
