// SPDX-License-Identifier: GPL-3.0-or-later
// KSeF token vault — encrypted-at-rest storage of long-lived secrets,
// keyed by a user-supplied passphrase. The derived AES-GCM key is held in
// the service worker's module scope while unlocked, and dropped on lock().
//
// Storage layout (chrome.storage.local):
//   "vault.meta"  → { version, iterations, salt, verification }
//                   `verification` is a small known plaintext encrypted with
//                   the unlock key, used to detect wrong-passphrase attempts
//                   before we ever try to read a real secret.
//   "vault.entries" → { [name: string]: Ciphertext }
//                     each entry is independently encrypted with the same
//                     unlock key but a fresh IV per write.

import {
  CRYPTO_PARAMS,
  type Ciphertext,
  type VaultKey,
  base64urlDecode,
  base64urlEncode,
  decryptString,
  deriveKey,
  encryptString,
  exportKeyToJwk,
  importKeyFromJwk,
  randomSalt,
} from "./crypto";
import { getRememberVault } from "./persistent-config";
import { log } from "../shared/logger";

const META_KEY = "vault.meta";
const ENTRIES_KEY = "vault.entries";
const SESSION_KEY_CACHE = "vault.sessionKey"; // chrome.storage.session
const LOCAL_KEY_CACHE = "vault.persistentKey"; // chrome.storage.local (remember mode)
const VERIFICATION_PLAINTEXT = "ksef-bridge-vault-v1";
const VAULT_VERSION = 1;

type VaultMeta = {
  version: number;
  iterations: number;
  salt: string; // base64url
  verification: Ciphertext;
};

type VaultEntries = Record<string, Ciphertext>;

// In-memory unlocked state. In MV3, the service worker is suspended after
// ~30s of inactivity and the module scope is wiped. To keep the vault
// "unlocked" across suspensions, we also cache the key (as JWK) in
// chrome.storage.session — which persists in RAM for the browser session
// but is cleared on browser restart. On every SW wake, restoreFromSession()
// re-hydrates the in-memory key if the session cache still has it.
let unlockedKey: VaultKey | null = null;

// --- Initialization ------------------------------------------------------

export async function isInitialized(): Promise<boolean> {
  const result = await chrome.storage.local.get(META_KEY);
  return META_KEY in result;
}

export function isUnlocked(): boolean {
  return unlockedKey !== null;
}

/**
 * Create a new vault with the given passphrase. If a vault already exists,
 * this fails — the caller must explicitly destroy() it first.
 */
export async function create(passphrase: string): Promise<void> {
  if (await isInitialized()) {
    throw new Error("vault already initialized — call destroy() first");
  }

  const salt = randomSalt();
  const key = await deriveKey(passphrase, salt);
  const verification = await encryptString(key, VERIFICATION_PLAINTEXT);

  const meta: VaultMeta = {
    version: VAULT_VERSION,
    iterations: CRYPTO_PARAMS.PBKDF2_ITERATIONS,
    salt: base64urlEncode(salt),
    verification,
  };

  await chrome.storage.local.set({
    [META_KEY]: meta,
    [ENTRIES_KEY]: {} satisfies VaultEntries,
  });

  unlockedKey = key;
  await cacheKeyToSession(key);
}

/**
 * Unlock an existing vault with the given passphrase. Returns true on
 * success, false on wrong passphrase. Throws if the vault doesn't exist
 * or storage is corrupt.
 */
export async function unlock(passphrase: string): Promise<boolean> {
  const meta = await loadMeta();
  if (!meta) {
    throw new Error("vault not initialized — call create() first");
  }

  const salt = base64urlDecode(meta.salt);
  const key = await deriveKey(passphrase, salt, meta.iterations);

  // Probe by attempting to decrypt the verification ciphertext. AES-GCM
  // throws on auth-tag mismatch, which is exactly what wrong-key triggers.
  try {
    const probe = await decryptString(key, meta.verification);
    if (probe !== VERIFICATION_PLAINTEXT) {
      return false;
    }
  } catch {
    return false;
  }

  unlockedKey = key;
  await cacheKeyToSession(key);
  return true;
}

export function lock(): void {
  unlockedKey = null;
  // Best-effort clear both caches. Fire-and-forget since lock() is sync.
  void chrome.storage.session.remove(SESSION_KEY_CACHE).catch(() => {});
  void chrome.storage.local.remove(LOCAL_KEY_CACHE).catch(() => {});
}

/**
 * Try to restore the unlocked key from chrome.storage.session. Called at
 * SW module load so the vault is automatically re-unlocked after Chrome
 * suspends and restarts the service worker. No-op if the session cache
 * is empty (browser restart, or user never unlocked).
 */
export async function restoreFromSession(): Promise<boolean> {
  if (unlockedKey) return true; // already unlocked
  try {
    // Try session first (covers SW suspension within same browser session).
    const sessionResult = await chrome.storage.session.get(SESSION_KEY_CACHE);
    const jwk = sessionResult[SESSION_KEY_CACHE] as JsonWebKey | undefined;
    if (jwk) {
      unlockedKey = await importKeyFromJwk(jwk);
      return true;
    }

    // Backwards-compat: detect and clear the old raw-JWK format that was
    // stored directly in chrome.storage.local (pre-0.2.0). An attacker who
    // copied the profile directory could extract the key from these files.
    const legacy = (await chrome.storage.local.get(LOCAL_KEY_CACHE))[LOCAL_KEY_CACHE];
    if (legacy && typeof legacy === "object" && "kty" in (legacy as Record<string, unknown>)) {
      await chrome.storage.local.remove(LOCAL_KEY_CACHE);
      log("info", "Cleared legacy unwrapped key cache; user will be prompted to unlock.");
      return false;
    }

    // Try the wrapped persistent cache (covers browser restart when
    // "remember" is on). The wrapped blob is useless without the
    // non-extractable wrapping key in IndexedDB.
    const restored = await restoreKeyPersistent();
    if (restored) {
      unlockedKey = restored;
      // Re-populate session cache so subsequent SW wakes are fast.
      const restoredJwk = await exportKeyToJwk(restored);
      await chrome.storage.session.set({ [SESSION_KEY_CACHE]: restoredJwk }).catch(() => {});
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Destroy the entire vault including all entries. Used in tests and as a
 * "forget everything and start over" button. Locks the vault as a side
 * effect.
 */
export async function destroy(): Promise<void> {
  await chrome.storage.local.remove([META_KEY, ENTRIES_KEY, LOCAL_KEY_CACHE]);
  await chrome.storage.session.remove(SESSION_KEY_CACHE).catch(() => {});
  // Also wipe the IndexedDB wrapping key so a future vault gets a fresh one.
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(WRAP_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort — IndexedDB may not be available in all contexts.
  }
  unlockedKey = null;
}

// --- Entry CRUD ----------------------------------------------------------

export async function setEntry(name: string, value: string): Promise<void> {
  const key = requireUnlocked();
  const entries = await loadEntries();
  entries[name] = await encryptString(key, value);
  await chrome.storage.local.set({ [ENTRIES_KEY]: entries });
}

export async function getEntry(name: string): Promise<string | null> {
  const key = requireUnlocked();
  const entries = await loadEntries();
  const ciphertext = entries[name];
  if (!ciphertext) return null;
  return decryptString(key, ciphertext);
}

export async function deleteEntry(name: string): Promise<void> {
  requireUnlocked();
  const entries = await loadEntries();
  if (!(name in entries)) return;
  delete entries[name];
  await chrome.storage.local.set({ [ENTRIES_KEY]: entries });
}

export async function listEntries(): Promise<string[]> {
  requireUnlocked();
  const entries = await loadEntries();
  return Object.keys(entries);
}

// --- Convenience accessors for the KSeF token ---------------------------
//
// Only SECRETS live in the vault. Non-secret persistent config (like the
// target Google Sheet ID) lives in src/storage/persistent-config.ts —
// outside the vault so it survives `vault.create()` rebuilds.

const KSEF_TOKEN_NAME = "ksef.token";
const CONTEXT_NIP_NAME = "ksef.contextNip";

export async function setKsefToken(token: string): Promise<void> {
  await setEntry(KSEF_TOKEN_NAME, token);
}

export async function getKsefToken(): Promise<string | null> {
  return getEntry(KSEF_TOKEN_NAME);
}

export async function clearKsefToken(): Promise<void> {
  await deleteEntry(KSEF_TOKEN_NAME);
}

/**
 * The KSeF "context identifier" is the NIP (or other ID) of the entity
 * whose invoices we're querying. Not a secret per se, but stored in the
 * vault for consistency — that way every "session"-shaped data point is
 * encrypted together and protected by the same passphrase.
 */
export async function setContextNip(nip: string): Promise<void> {
  await setEntry(CONTEXT_NIP_NAME, nip);
}

export async function getContextNip(): Promise<string | null> {
  return getEntry(CONTEXT_NIP_NAME);
}

// targetSpreadsheetId moved to src/storage/persistent-config.ts in M3 sub-turn 1
// so it survives vault.create() rebuilds. See that file for accessors.

// --- Internals -----------------------------------------------------------

function requireUnlocked(): VaultKey {
  if (!unlockedKey) {
    throw new Error("vault is locked — call unlock() first");
  }
  return unlockedKey;
}

async function loadMeta(): Promise<VaultMeta | null> {
  const result = await chrome.storage.local.get(META_KEY);
  return (result[META_KEY] as VaultMeta | undefined) ?? null;
}

async function loadEntries(): Promise<VaultEntries> {
  const result = await chrome.storage.local.get(ENTRIES_KEY);
  return (result[ENTRIES_KEY] as VaultEntries | undefined) ?? {};
}

/**
 * Re-cache the current in-memory key to session + local (if remember is on).
 * Called when the "remember" toggle changes while the vault is unlocked.
 */
export async function reCacheKey(): Promise<void> {
  if (unlockedKey) {
    await cacheKeyToSession(unlockedKey);
  }
}

async function cacheKeyToSession(key: VaultKey): Promise<void> {
  try {
    const jwk = await exportKeyToJwk(key);
    // Always cache in session (survives SW suspension within same browser session).
    await chrome.storage.session.set({ [SESSION_KEY_CACHE]: jwk });
    // If "remember" is enabled, ALSO cache persistently via the IndexedDB
    // wrapping key. The wrapped blob in chrome.storage.local is useless
    // without the non-extractable CryptoKey held in IndexedDB — which the
    // browser refuses to export, so a copied profile directory can't use it.
    const remember = await getRememberVault();
    if (remember) {
      await cacheKeyPersistent(key);
    }
  } catch {
    // Non-fatal: if caching fails, we still have the in-memory key.
  }
}

// ---------------------------------------------------------------------------
// IndexedDB key storage — holds a non-extractable AES-GCM wrapping key.
// Browsers persist non-extractable CryptoKey objects across sessions via
// structured clone. This is the entire reason IndexedDB is used over
// chrome.storage.local for this one value: the browser's internal key store
// is opaque to filesystem inspection.
// ---------------------------------------------------------------------------

const IDB_NAME = "ksef-invosync-vault";
const IDB_STORE = "wrapKey";
const WRAP_KEY_ID = "v1";

async function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  const db = await openIdb();

  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(WRAP_KEY_ID);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;

  // Generate a non-extractable key. This is the entire security property:
  // the browser will never allow this key to leave the process, so a copied
  // profile directory yields ciphertext with no way to unwrap.
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // NOT extractable — this is the whole point
    ["wrapKey", "unwrapKey"],
  );

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(key, WRAP_KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return key;
}

// ---------------------------------------------------------------------------
// Persistent cache: { wrapped, iv } in chrome.storage.local, unwrappable
// only with the non-extractable key in IndexedDB.
// ---------------------------------------------------------------------------

type WrappedKeyBlob = { wrapped: string; iv: string };

async function cacheKeyPersistent(vaultKey: VaultKey): Promise<void> {
  const wrapKey = await getOrCreateWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedBuf = await crypto.subtle.wrapKey(
    "raw",
    vaultKey,
    wrapKey,
    { name: "AES-GCM", iv },
  );
  const blob: WrappedKeyBlob = {
    wrapped: base64urlEncode(new Uint8Array(wrappedBuf)),
    iv: base64urlEncode(iv),
  };
  await chrome.storage.local.set({ [LOCAL_KEY_CACHE]: blob });
}

async function restoreKeyPersistent(): Promise<VaultKey | null> {
  const result = await chrome.storage.local.get(LOCAL_KEY_CACHE);
  const stored = result[LOCAL_KEY_CACHE] as WrappedKeyBlob | undefined;
  if (!stored || !stored.wrapped || !stored.iv) return null;

  try {
    const wrapKey = await getOrCreateWrappingKey();
    return await crypto.subtle.unwrapKey(
      "raw",
      base64urlDecode(stored.wrapped),
      wrapKey,
      { name: "AES-GCM", iv: base64urlDecode(stored.iv) },
      { name: "AES-GCM", length: 256 },
      true, // the unwrapped vault key IS extractable (we need to export it to JWK for session cache)
      ["encrypt", "decrypt"],
    ) as VaultKey;
  } catch {
    // Wrapping key was regenerated (IndexedDB cleared by user / browser update)
    // — stored blob is dead. Clean up.
    await chrome.storage.local.remove(LOCAL_KEY_CACHE);
    log("info", "Wrapped key cache invalid (IndexedDB wrapping key changed); cleared.");
    return null;
  }
}

// Test-only escape hatch: clears the in-memory key without touching storage,
// so a test can simulate "browser restart" without re-initializing.
export const __testing = {
  forgetUnlockedKey() {
    unlockedKey = null;
  },
};
