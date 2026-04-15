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
- **"Remember passphrase"** option: caches the JWK in `chrome.storage.local` (survives restart)

### Threat Model

| Threat | Mitigation |
|---|---|
| Someone reads `chrome.storage.local` | KSeF token is AES-GCM encrypted, need passphrase to decrypt |
| SW suspension loses in-memory key | JWK cached in session storage, restored on SW wake |
| Browser restart | Session cache cleared; user re-enters passphrase (unless "remember" is on) |
| "Remember" enabled + disk access | JWK in local storage is readable — same risk as saved Chrome passwords |
| Extension code inspection | No secrets in source; client_secret is a public identifier per Google OAuth-for-installed-apps spec |
| Network interception | All API calls over HTTPS; KSeF token encrypted in transit via RSA-OAEP-SHA256 |

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
- Scopes: `userinfo.email`, `userinfo.profile`, `drive.file`, `spreadsheets`
- `drive.file` scope: extension only sees spreadsheets it created (not all Drive files)
- `access_type=offline` for refresh token (auto-refreshes expired access tokens)
- Tokens stored in `chrome.storage.local` (survive restart)

## Manifest Permissions

```json
"permissions": ["identity", "storage", "alarms", "notifications"]
```

| Permission | Why |
|---|---|
| `identity` | `chrome.identity.launchWebAuthFlow` for Google OAuth |
| `storage` | `chrome.storage.local` + `session` for vault, config, tokens |
| `alarms` | `chrome.alarms` for periodic auto-sync |
| `notifications` | Desktop notifications for sync results |

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
