# KSeF InvoSync — Security Architecture

## Principles

1. **No backend** — all data stays between your browser, KSeF (gov), and Google
2. **SubtleCrypto only** — no third-party crypto libraries, browser-native Web Crypto API
3. **Minimal permissions** — only what's strictly needed
4. **No telemetry** — zero analytics, no tracking, no phone-home

## Encrypted Vault

The KSeF token (your authentication credential) is encrypted at rest in `chrome.storage.local`.

### Algorithms

| Component | Algorithm | Parameters |
|---|---|---|
| Key derivation | PBKDF2-HMAC-SHA256 | 310,000 iterations (OWASP 2023+ floor) |
| Encryption | AES-256-GCM | Fresh 12-byte IV per write |
| Salt | Random | 128-bit (16 bytes) |

### Flow

```
User enters passphrase
        │
        ▼
  ┌─────────────┐
  │   PBKDF2    │  passphrase + random salt → 256-bit AES-GCM key
  │  310k iter  │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  AES-GCM    │  encrypt(key, KSeF_token) → ciphertext + IV + auth_tag
  │  256-bit    │
  └──────┬──────┘
         │
         ▼
  chrome.storage.local  ← { salt, ciphertext, IV, auth_tag }
```

### Wrong Passphrase Detection

- A known plaintext (`"ksef-bridge-vault-v1"`) is encrypted alongside the real entries
- On unlock, the vault tries to decrypt this probe first
- AES-GCM's authentication tag fails loudly on wrong key → `false` returned, no data exposed

### Session Persistence

- After unlock, the derived `CryptoKey` is exported as JWK
- Stored in `chrome.storage.session` (RAM-only, cleared on browser restart)
- MV3 service workers suspend after ~30s idle — the session cache survives suspensions

### "Keep unlocked across browser restarts" (opt-in)

When the user enables this, the vault key is persisted via an IndexedDB-wrapped
blob (not a raw JWK):

1. A **non-extractable** `AES-GCM-256` `CryptoKey` is generated once and stored
   in IndexedDB (`ksef-invosync-vault` DB, `wrapKey` store). The browser
   refuses to export this key — it cannot leave the browser process even via
   code inspection.
2. The vault key is wrapped (`crypto.subtle.wrapKey`) with that IndexedDB key
   before being written to `chrome.storage.local` as `{ wrapped, iv }`.
3. On restore, `crypto.subtle.unwrapKey` uses the IndexedDB key to recover
   the vault key.

**Why this matters:** A copied Chrome profile directory yields only ciphertext
and an IV. Without the non-extractable CryptoKey (which is tied to the
browser's internal key store and opaque to filesystem inspection), the blob
cannot be decrypted.

Legacy raw-JWK caches (pre-0.1.1) are auto-detected and cleared on first run
after upgrade; the user is prompted to re-unlock once.

### Threat Model

| Threat | Mitigation |
|---|---|
| Someone reads `chrome.storage.local` | KSeF token is AES-GCM encrypted, need passphrase to decrypt |
| SW suspension loses in-memory key | JWK cached in session storage, restored on SW wake |
| Browser restart | Session cache cleared; user re-enters passphrase (unless "keep unlocked" is on) |
| "Keep unlocked" enabled + copied profile dir | Stored blob is ciphertext only — the non-extractable IndexedDB wrapping key cannot be exported. Raises the bar from "copy two files" to "run code inside the user's Chrome." |
| Stolen laptop, disk encryption off | Same as above — ciphertext useless outside the original browser process |
| Remote browser exploit / malware with user-level code execution | Cannot prevent in a pure-browser design. Any attacker running JS inside the browser can call `unwrapKey`. Future enhancement: native-messaging host using OS credential store (Keychain / DPAPI / libsecret). |
| Extension code inspection | No secrets in source; client_secret is a public identifier per Google OAuth-for-installed-apps spec |
| External message injection to the SW | `chrome.runtime.onMessage` listener verifies `sender.id === chrome.runtime.id` and rejects external senders |
| Network interception | All API calls over HTTPS; KSeF token encrypted in transit via RSA-OAEP-SHA256 |
| Accidental secret commit | Gitleaks pre-commit hook scans every commit (pattern-match against 700+ key types); commit is blocked on match |

## KSeF Authentication

### Token-Based Auth Flow

```
1. GET  /security/public-key-certificates    → KsefTokenEncryption cert (RSA)
2. POST /auth/challenge                       → challenge + timestampMs
3. RSA-OAEP-SHA256 encrypt("{token}|{timestampMs}") with cert public key
4. POST /auth/ksef-token                      → referenceNumber + temp JWT
5. GET  /auth/{ref}  (poll until code=200)    → auth status
6. POST /auth/token/redeem                    → access_token + refresh_token
7. DELETE /auth/sessions/current              → revoke after sync (best-effort)
```

### Certificate Types (Important!)

KSeF has TWO types of public key certificates:
- **KsefTokenEncryption** — used in step 3 above (auth)
- **SymmetricKeyEncryption** — used for upload sessions (wraps AES key)

Using the wrong cert gives `415 Błąd odszyfrowania dostarczonego klucza`.

## Google OAuth

- PKCE flow via `chrome.identity.launchWebAuthFlow`
- Code verifier: 32 random bytes, SHA-256 challenge
- CSRF `state` parameter verified on callback
- Scopes: `userinfo.email`, `userinfo.profile`, `drive.file`, `spreadsheets`, `calendar.events`, `calendar.calendarlist.readonly`
- `drive.file` scope: extension only sees spreadsheets it created (not all Drive files)
- `calendar.calendarlist.readonly` scope: reads only calendar names/IDs for the target-calendar picker — never event contents
- `calendar.events` scope: creates events only when the user explicitly clicks "Add to Calendar" on a specific invoice. Never reads, modifies, or deletes other calendar events
- `access_type=offline` for refresh token (auto-refreshes expired access tokens)
- Tokens stored in `chrome.storage.local` (survive restart)
- Google integrations are entirely opt-in — no token exists until the user clicks "Connect Google" in the popup

## Manifest Permissions

```json
"permissions": ["identity", "storage", "alarms", "notifications", "idle"]
```

| Permission | Why |
|---|---|
| `identity` | `chrome.identity.launchWebAuthFlow` for Google OAuth |
| `storage` | `chrome.storage.local` + `session` for vault, config, tokens |
| `alarms` | `chrome.alarms` for periodic auto-sync |
| `notifications` | Desktop notifications for sync results |
| `idle` | `chrome.idle.onStateChanged` trigger for catch-up sync on browser wake / unlock. Only the "active" state event is used — no idle data stored or transmitted. User-toggleable ("Catch up on browser start / wake from sleep", default ON). |

### Host Permissions

```json
"host_permissions": [
  "https://api-test.ksef.mf.gov.pl/*",
  "https://api-demo.ksef.mf.gov.pl/*",
  "https://api.ksef.mf.gov.pl/*",
  "https://sheets.googleapis.com/*",
  "https://www.googleapis.com/*",
  "https://oauth2.googleapis.com/*"
]
```

Only KSeF + Google APIs. No other external endpoints.

## Content Security Policy

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

No inline scripts, no eval, no external script loading.

## Supply-chain: pre-commit secret scanning

Every commit is automatically scanned by [gitleaks](https://github.com/gitleaks/gitleaks) via a pre-commit hook (configured in `.pre-commit-config.yaml`). If a pattern matching an API key, OAuth secret, JWT, RSA private key, AWS/Google/Azure credential, or generic high-entropy secret is detected in the staged diff, the commit is **blocked** before it can be created.

Test fixtures containing deliberately-generated dummy keys (e.g. `tests/fixtures/test-cert.ts` for the ASN.1 parser unit tests) are allowlisted explicitly by fingerprint in `.gitleaksignore`.

## Changelog

### 0.1.1 — security review follow-up

Following a full-source security review, the following hardening was applied:

- **Message-sender verification**: the service-worker `chrome.runtime.onMessage` listener now verifies `sender.id === chrome.runtime.id` and rejects messages from external senders. Defense-in-depth against future changes that might add `externally_connectable` or content scripts.
- **IndexedDB-wrapped persistent key cache**: when "Keep unlocked across browser restarts" is enabled, the vault key is now wrapped with a non-extractable `CryptoKey` held in IndexedDB, instead of being stored as a raw JWK in `chrome.storage.local`. A copied Chrome profile directory yields only ciphertext that cannot be decrypted outside the original browser process.
- **Legacy cache migration**: pre-0.1.1 raw-JWK caches are auto-detected and cleared on first run after upgrade.
- **OAuth setup guidance**: dedicated [docs/OAUTH-SETUP.md](OAUTH-SETUP.md) documents which OAuth client type (Web application) to create and explains that `client_secret` is a public identifier per Google's installed-app spec.
- **Gitleaks pre-commit hook**: blocks commits containing secret patterns.
- **New e2e tests**: 4 tests covering IndexedDB wrapping (blob format, restore after SW wipe, legacy migration, destroy), plus 4 tests for catch-up sync decision logic.

### 0.1.0 — initial release

- Encrypted vault (PBKDF2 310k + AES-256-GCM)
- Google OAuth 2.0 + PKCE with CSRF state verification
- ASN.1 SPKI parser hand-rolled (~100 lines, bounds-checked, rejects indefinite-length DER)
- FA(3) XML parser using `DOMParser` (no regex, no HTML injection sink)
- Zero `innerHTML` / `dangerouslySetInnerHTML` / `document.write` / `eval` anywhere in `src/`
- Scoped host permissions (3 KSeF + 3 Google APIs, no `<all_urls>`)
- Strict CSP: `script-src 'self'; object-src 'self'`
