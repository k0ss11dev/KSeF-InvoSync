# Google OAuth Setup

## Which OAuth client type to create

This extension uses `chrome.identity.launchWebAuthFlow` + PKCE for Google OAuth — **not** the simpler `chrome.identity.getAuthToken`. This means you need a **"Web application"** OAuth client, not a "Chrome extension" type.

Why `launchWebAuthFlow` over `getAuthToken`:
- Works in both Chrome and Firefox (cross-browser)
- Shows account picker (users with multiple Google accounts can choose)
- Full control over token refresh + revocation + PKCE

## Step-by-step

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: anything (e.g. "KSeF InvoSync dev")
5. **Authorized redirect URIs** → Add:
   ```
   https://<your-extension-id>.chromiumapp.org/
   ```
   To find your extension ID: `chrome://extensions` → enable Developer mode → your extension's ID is shown under the name.
6. Click **Create** → copy **Client ID** and **Client Secret**
7. Paste them into your `.env`:
   ```
   GOOGLE_CLIENT_ID=246852433818-xxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
   ```

## Enable required APIs

In the same Google Cloud project, enable these APIs via [APIs & Services → Library](https://console.cloud.google.com/apis/library):

- **Google Sheets API**
- **Google Drive API**
- **Google Calendar API** (only if using the Calendar feature)

## OAuth consent screen

1. [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. User type: **External** (or Internal for Workspace orgs)
3. App name, support email, developer contact — fill in
4. Scopes: add the following (or skip — the extension requests them at runtime):
   - `userinfo.email`
   - `userinfo.profile`
   - `drive.file`
   - `spreadsheets`
   - `calendar.events`
   - `calendar.calendarlist.readonly`
5. Test users: add your Google account email (required while app is in "Testing" status)
6. While in "Testing" status, the consent screen shows "Google hasn't verified this app" — users click **Advanced → Go to [app name] (unsafe)** to proceed. This is normal for development.

## Security notes for fork authors

- The `client_secret` for installed/desktop/extension OAuth clients is treated by Google as a [public identifier](https://developers.google.com/identity/protocols/oauth2/native-app#creatingcred), not a true secret. It ships inside every built extension. PKCE protects the actual token exchange.
- **Do not** reuse your production Web application credentials. Create a separate OAuth client specifically for the extension.
- The `GOOGLE_CLIENT_SECRET` is injected at build time via `__GOOGLE_CLIENT_SECRET__` in `src/google/auth.ts`. The code makes it optional: `if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET)`.
- If you ever switch to `chrome.identity.getAuthToken` (Chrome-only, simpler), use the "Chrome extension" OAuth client type instead — no secret needed, no redirect URI, scopes go in the manifest `oauth2` block.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | Redirect URI in OAuth client doesn't match extension ID | Add `https://<ext-id>.chromiumapp.org/` (with trailing `/`) to Authorized redirect URIs |
| `The user did not approve access` | Your Google account isn't added as a Test User | OAuth consent screen → Test users → add your email |
| `Access blocked: app has not been verified` | Normal for "Testing" status apps | Click **Advanced → Go to [app name] (unsafe)** |
| `403 insufficientPermissions` on Calendar/Sheets | API not enabled in the GCP project | Enable the API in [Library](https://console.cloud.google.com/apis/library) |
| Extension ID changes between installs | No `key` field in manifest | For dev: put the public key in `manifests/chrome.key.local` (gitignored) — build injects it to pin the ID |
