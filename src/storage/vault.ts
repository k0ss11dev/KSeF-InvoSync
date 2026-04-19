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
    // Backwards-compat: detect legacy raw-JWK entries in either storage area
    // (pre-0.1.2 session cache, pre-0.1.1 local cache) and clear them. Both
    // used to expose raw key bytes; neither is safe to restore from.
    const legacySession = (await chrome.storage.session.get(SESSION_KEY_CACHE))[SESSION_KEY_CACHE];
    if (legacySession && typeof legacySession === "object" && "kty" in (legacySession as Record<string, unknown>)) {
      await chrome.storage.session.remove(SESSION_KEY_CACHE);
      log("info", "Cleared legacy raw-JWK session cache.");
    }
    const legacyLocal = (await chrome.storage.local.get(LOCAL_KEY_CACHE))[LOCAL_KEY_CACHE];
    if (legacyLocal && typeof legacyLocal === "object" && "kty" in (legacyLocal as Record<string, unknown>)) {
      await chrome.storage.local.remove(LOCAL_KEY_CACHE);
      log("info", "Cleared legacy raw-JWK persistent cache.");
    }

    // Try the wrapped session cache first (covers SW suspension within same
    // browser session — fast path).
    const fromSession = await restoreKeyWrapped(chrome.storage.session, SESSION_KEY_CACHE);
    if (fromSession) {
      unlockedKey = fromSession;
      return true;
    }

    // Fall back to the wrapped persistent cache (covers browser restart when
    // "remember" is on). Re-populate session cache on success so subsequent
    // SW wakes hit the fast path.
    const fromPersistent = await restoreKeyWrapped(chrome.storage.local, LOCAL_KEY_CACHE);
    if (fromPersistent) {
      unlockedKey = fromPersistent;
      await cacheKeyWrapped(fromPersistent, chrome.storage.session, SESSION_KEY_CACHE).catch(() => {});
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
    // Session cache (always written): wrapped with the non-extractable
    // IndexedDB CryptoKey, same as the persistent path. This closes the
    // hole where any code that could reach chrome.storage.session (future
    // content scripts, test bridges in dev builds) could read the raw
    // AES-GCM key as a JWK.
    await cacheKeyWrapped(key, chrome.storage.session, SESSION_KEY_CACHE);
    // If "remember" is enabled, ALSO cache persistently in local storage.
    const remember = await getRememberVault();
    if (remember) {
      await cacheKeyWrapped(key, chrome.storage.local, LOCAL_KEY_CACHE);
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

/**
 * Wrap the vault key with the non-extractable IndexedDB CryptoKey and write
 * the resulting blob to the given storage area under the given cache key.
 * Used for both the session cache (chrome.storage.session) and the persistent
 * cache (chrome.storage.local). Neither storage area ever holds raw key bytes.
 */
async function cacheKeyWrapped(
  vaultKey: VaultKey,
  storage: chrome.storage.StorageArea,
  cacheKeyName: string,
): Promise<void> {
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
  await storage.set({ [cacheKeyName]: blob });
}

/**
 * Unwrap a blob previously written by cacheKeyWrapped. Returns null if the
 * blob is missing or if the wrapping key has been regenerated (in which case
 * the stale blob is cleaned up).
 *
 * The recovered vault key is non-extractable: since both the session and
 * persistent caches now go through wrapKey, we never need to export the vault
 * key to JWK again — it can stay opaque for its entire lifetime.
 */
async function restoreKeyWrapped(
  storage: chrome.storage.StorageArea,
  cacheKeyName: string,
): Promise<VaultKey | null> {
  const result = await storage.get(cacheKeyName);
  const stored = result[cacheKeyName] as WrappedKeyBlob | undefined;
  if (!stored || !stored.wrapped || !stored.iv) return null;

  try {
    const wrapKey = await getOrCreateWrappingKey();
    return await crypto.subtle.unwrapKey(
      "raw",
      base64urlDecode(stored.wrapped),
      wrapKey,
      { name: "AES-GCM", iv: base64urlDecode(stored.iv) },
      { name: "AES-GCM", length: 256 },
      false, // non-extractable — vault key never leaves the browser process again
      ["encrypt", "decrypt"],
    ) as VaultKey;
  } catch {
    // Wrapping key was regenerated (IndexedDB cleared by user / browser update)
    // — stored blob is dead. Clean up.
    await storage.remove(cacheKeyName);
    log("info", `Wrapped key cache invalid (${cacheKeyName}); cleared.`);
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
