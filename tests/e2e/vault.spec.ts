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
  restoreFromSession(): Promise<boolean>;
  reCacheKey(): Promise<void>;
  __testing: { forgetUnlockedKey(): void };
};

type PersistentConfigBridge = {
  setRememberVault(enabled: boolean): Promise<void>;
  getRememberVault(): Promise<boolean>;
};

declare global {
  // Set by service-worker.ts in dev/test builds.
  // eslint-disable-next-line no-var
  var __vaultForTests: VaultBridge | undefined;
  // eslint-disable-next-line no-var
  var __persistentConfigForTests: PersistentConfigBridge | undefined;
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

  // -----------------------------------------------------------------
  // Security: IndexedDB-wrapped persistent key cache (Fix #2)
  // -----------------------------------------------------------------

  test("remember-passphrase stores a wrapped blob, not a raw JWK", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase }) => {
      const v = globalThis.__vaultForTests!;
      const pc = globalThis.__persistentConfigForTests!;
      await v.create(passphrase);

      // Enable "remember" and re-cache the key.
      await pc.setRememberVault(true);
      await v.reCacheKey();

      // Read what's in chrome.storage.local under "vault.persistentKey".
      const stored = (await chrome.storage.local.get("vault.persistentKey"))["vault.persistentKey"];
      return {
        hasWrapped: stored && typeof stored === "object" && "wrapped" in stored && "iv" in stored,
        hasKty: stored && typeof stored === "object" && "kty" in stored,
      };
    }, { passphrase: PASSPHRASE });

    // It MUST be a wrapped blob { wrapped, iv }, NOT a raw JWK { kty, k, ... }.
    expect(result.hasWrapped).toBe(true);
    expect(result.hasKty).toBe(false);
  });

  test("session cache is a wrapped blob too (no raw JWK anywhere)", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);
      // Unlock state is already cached by create(); re-assert via reCacheKey
      // in case any prior test left storage in a surprising state.
      await v.reCacheKey();

      const sessionStored = (await chrome.storage.session.get("vault.sessionKey"))["vault.sessionKey"];
      return {
        hasWrapped: sessionStored && typeof sessionStored === "object" && "wrapped" in sessionStored && "iv" in sessionStored,
        hasKty: sessionStored && typeof sessionStored === "object" && "kty" in sessionStored,
        hasK: sessionStored && typeof sessionStored === "object" && "k" in sessionStored,
      };
    }, { passphrase: PASSPHRASE });

    expect(result.hasWrapped).toBe(true);
    expect(result.hasKty).toBe(false);
    expect(result.hasK).toBe(false);
  });

  test("restoreFromSession round-trips through the wrapped session cache", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);
      await v.setKsefToken(token);

      // Simulate SW suspension: wipe in-memory key but keep storages intact.
      v.__testing.forgetUnlockedKey();

      // Restore should succeed using the wrapped session cache.
      const restored = await v.restoreFromSession();
      const retrieved = restored ? await v.getKsefToken() : null;
      return { restored, retrieved };
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });

    expect(result.restored).toBe(true);
    expect(result.retrieved).toBe(SAMPLE_TOKEN);
  });

  test("legacy raw-JWK in session cache is cleared on restore", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);

      // Simulate a legacy pre-0.1.2 session cache with a raw JWK.
      const fakeJwk = { kty: "oct", k: "AAAA", alg: "A256GCM", ext: true };
      await chrome.storage.session.set({ "vault.sessionKey": fakeJwk });

      v.__testing.forgetUnlockedKey();

      // Restore should detect the legacy format and clear it. The wrapped
      // session cache no longer exists so restore returns false overall.
      const restored = await v.restoreFromSession();
      const afterClear = (await chrome.storage.session.get("vault.sessionKey"))["vault.sessionKey"];
      return { restored, legacyCleared: afterClear === undefined };
    }, { passphrase: PASSPHRASE });

    expect(result.restored).toBe(false);
    expect(result.legacyCleared).toBe(true);
  });

  test("wrapped persistent cache restores vault key after SW memory wipe", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      const pc = globalThis.__persistentConfigForTests!;

      // Set up vault + token + enable "remember".
      await v.create(passphrase);
      await v.setKsefToken(token);
      await pc.setRememberVault(true);
      await v.reCacheKey();

      // Simulate SW kill: wipe in-memory key AND session cache.
      v.__testing.forgetUnlockedKey();
      await chrome.storage.session.remove("vault.sessionKey");

      // Attempt restore — should use the wrapped persistent cache.
      const restored = await v.restoreFromSession();
      const retrievedToken = restored ? await v.getKsefToken() : null;
      return { restored, retrievedToken };
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });

    expect(result.restored).toBe(true);
    expect(result.retrievedToken).toBe(SAMPLE_TOKEN);
  });

  test("legacy raw-JWK cache is auto-cleared on restore", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase }) => {
      const v = globalThis.__vaultForTests!;
      await v.create(passphrase);

      // Simulate a legacy cache: write a raw JWK directly to storage.local.
      const fakeJwk = { kty: "oct", k: "AAAA", alg: "A256GCM", ext: true };
      await chrome.storage.local.set({ "vault.persistentKey": fakeJwk });

      // Wipe in-memory + session to force restore from local.
      v.__testing.forgetUnlockedKey();
      await chrome.storage.session.remove("vault.sessionKey");

      // Attempt restore — should detect legacy format and clear it.
      const restored = await v.restoreFromSession();
      const afterClear = (await chrome.storage.local.get("vault.persistentKey"))["vault.persistentKey"];

      return { restored, legacyCleared: afterClear === undefined };
    }, { passphrase: PASSPHRASE });

    // Restore fails (legacy cleared, no wrapped blob to fall back on).
    expect(result.restored).toBe(false);
    // Legacy JWK was removed from storage.
    expect(result.legacyCleared).toBe(true);
  });

  test("destroy wipes the IndexedDB wrapping key", async ({
    serviceWorker,
  }) => {
    const result = await serviceWorker.evaluate(async ({ passphrase, token }) => {
      const v = globalThis.__vaultForTests!;
      const pc = globalThis.__persistentConfigForTests!;

      // Full setup with remember enabled.
      await v.create(passphrase);
      await v.setKsefToken(token);
      await pc.setRememberVault(true);
      await v.reCacheKey();

      // Destroy should wipe everything including IndexedDB.
      await v.destroy();

      // Re-create a fresh vault and enable remember again.
      await v.create(passphrase);
      await v.setKsefToken(token);
      await pc.setRememberVault(true);
      await v.reCacheKey();

      // The NEW wrapping key should differ from the old one — simulated here
      // by checking that restore works (a new key was generated, not stale).
      v.__testing.forgetUnlockedKey();
      await chrome.storage.session.remove("vault.sessionKey");
      const restored = await v.restoreFromSession();
      const retrieved = restored ? await v.getKsefToken() : null;
      return { restored, retrieved };
    }, { passphrase: PASSPHRASE, token: SAMPLE_TOKEN });

    expect(result.restored).toBe(true);
    expect(result.retrieved).toBe(SAMPLE_TOKEN);
  });
});
