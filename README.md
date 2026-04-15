# KSeF InvoSync

**Sync invoices from Polish KSeF to Google Sheets — automatically.**

Free, open-source browser extension (MV3). No backend, no paid accounts, no infrastructure. Your browser + your Google account + your KSeF token = full invoice sync.

> **[🇵🇱 Wersja polska poniżej](#-ksef-invosync--wersja-polska)**

---

## Demo

<p align="center">
  <img src="docs/videos/live-demo.gif" alt="Live demo: three fresh incoming invoices arriving in the popup feed with unread highlight" width="320" />
</p>

Vault setup, baseline sync, then three fresh incoming invoices arrive at the top of the feed with the unread highlight. Higher-quality original: [webm](docs/videos/live-demo.webm) · [mp4](docs/videos/live-demo.mp4).

<details>
<summary><strong>📸 Screenshots</strong> — click to expand</summary>

<p align="center">
  <img src="docs/screenshots/popup-status-light.png" alt="Status Tab — light" width="320" />
  <img src="docs/screenshots/popup-status-dark.png" alt="Status Tab — dark" width="320" />
</p>

<p align="center">
  <img src="docs/screenshots/popup-config-light.png" alt="Config Tab — light" width="320" />
  <img src="docs/screenshots/popup-config-dark.png" alt="Config Tab — dark" width="320" />
</p>

<p align="center">
  <img src="docs/screenshots/popup-with-new-incoming.png" alt="Fresh incoming invoices highlighted at top of the feed" width="380" />
</p>

<p align="center">
  <img src="docs/screenshots/options-page.png" alt="Options page" width="700" />
</p>

<p align="center">
  <img src="docs/screenshots/sheets-1.jpg" alt="Google Sheets Dashboard" width="700" />
</p>

</details>

---

## Features

- **Auto-sync** — pulls invoices from KSeF every 30min / 1h / 3h / 6h in the background
- **Outgoing + Incoming** — separate tabs in the same Google Sheet (Subject1 + Subject2)
- **Incoming invoice feed** — messenger-style list with unread badges, click to view
- **Invoice viewer** — inline FA(3) XML parser: seller, buyer, line items, due-date banner
- **Add to Calendar** — one click adds the payment due date to your Google Calendar (with 3-day + 1-day reminders); target calendar is user-pickable in settings
- **Catch-up on resume** — pulls fresh data automatically when the browser starts or the computer wakes from sleep, if the last sync is older than the configured interval
- **Diagnostic logs viewer** — in-memory ring buffer of SW events with Copy-to-clipboard, for bug reports
- **Dashboard** — auto-computed totals (net, VAT, gross, balance) + 5 charts
- **Dedup** — only new invoices are appended, no duplicates ever
- **Notifications** — Chrome notifications for new invoices, sync results, errors (configurable)
- **Encrypted vault** — KSeF token encrypted with PBKDF2 + AES-GCM, passphrase-protected
- **Remember passphrase** — optional, survives browser restart for unattended auto-sync
- **Dark mode** — MUI theme, follows system or manual toggle
- **i18n** — English + Polish, switchable in settings
- **KSeF environment switch** — test / demo / production
- **Connection test** — verify your KSeF token works before syncing
- **Sheet picker** — choose which spreadsheet to sync to, or create a new one
- **Status badge** — colored dot on the extension icon shows sync health
- **Progress bar** — visual countdown to next auto-sync
- **GPL-3.0** — free software, no commercial reuse without sharing code

## Quick Start

1. Install the extension (Chrome Web Store / Firefox AMO — coming soon)
2. Click the extension icon → **Config** tab
3. Paste your KSeF token (NIP auto-detected) → set a passphrase → **Set up vault**
4. Connect Google → authorize Sheets + Drive access
5. Switch to **Status** tab → **Sync now**
6. Open the 📊 sheet link to see your invoices + dashboard

## Tech Stack

- TypeScript + React + Material UI (MUI) on Emotion
- Manifest V3 (Chrome + Firefox)
- esbuild (no Vite, no webpack)
- Web Crypto API (PBKDF2, AES-GCM, RSA-OAEP)
- Playwright e2e tests in Docker

## Development

```bash
# Install
npm install

# Build Chrome
npm run build:chrome

# Build Firefox
npm run build:firefox

# Run tests (Docker required)
npm run test:docker

# Load in Chrome
# 1. chrome://extensions → Developer mode ON
# 2. Load unpacked → select dist/chrome/
```

### Environment Variables

Copy `.env.example` → `.env` and fill in:

```
GOOGLE_CLIENT_ID=your-oauth-client-id
GOOGLE_CLIENT_SECRET=your-oauth-client-secret
```

## Architecture

```
src/
├── background/          Service worker (MV3)
│   ├── service-worker.ts   Message router + event listeners
│   ├── auto-sync.ts        chrome.alarms + background sync
│   └── notifications.ts    Chrome notifications
├── popup/               Extension popup (React)
│   ├── App.tsx             Tabbed layout: Status | Config
│   └── popup.css           Layout helpers + dark-mode bridges
├── options/             Full-page settings (React)
├── google/              Google APIs (OAuth, Sheets, Drive)
├── ksef/                KSeF APIs (auth, query, upload, FA3)
├── storage/             Vault (encrypted) + persistent config
└── shared/              i18n, messages, errors, logger
```

## License

GPL-3.0-or-later — see [LICENSE](LICENSE)

**Author:** k0ss11

---

# 🇵🇱 KSeF InvoSync — Wersja polska

**Synchronizacja faktur z KSeF do Arkuszy Google — automatycznie.**

Darmowe rozszerzenie przeglądarki (MV3) o otwartym kodzie źródłowym. Bez backendu, bez płatnych kont, bez infrastruktury. Twoja przeglądarka + Twoje konto Google + Twój token KSeF = pełna synchronizacja faktur.

---

## Demo

<p align="center">
  <img src="docs/videos/live-demo.gif" alt="Demo na żywo: trzy świeże faktury przychodzące pojawiają się na górze listy w popupie z wyróżnieniem nieprzeczytanych" width="320" />
</p>

Konfiguracja sejfu, wstępna synchronizacja, następnie trzy świeże faktury przychodzące pojawiają się na górze listy z wyróżnieniem nieprzeczytanych. Oryginał w lepszej jakości: [webm](docs/videos/live-demo.webm) · [mp4](docs/videos/live-demo.mp4).

<details>
<summary><strong>📸 Zrzuty ekranu</strong> — kliknij, by rozwinąć</summary>

<p align="center">
  <img src="docs/screenshots/popup-status-light.png" alt="Zakładka Status — jasny" width="320" />
  <img src="docs/screenshots/popup-status-dark.png" alt="Zakładka Status — ciemny" width="320" />
</p>

<p align="center">
  <img src="docs/screenshots/popup-config-light.png" alt="Zakładka Konfiguracja — jasny" width="320" />
  <img src="docs/screenshots/popup-config-dark.png" alt="Zakładka Konfiguracja — ciemny" width="320" />
</p>

<p align="center">
  <img src="docs/screenshots/popup-with-new-incoming.png" alt="Świeże faktury przychodzące wyróżnione na górze listy" width="380" />
</p>

<p align="center">
  <img src="docs/screenshots/sheets-1.jpg" alt="Dashboard w Arkuszach Google" width="700" />
</p>

</details>

---

## Funkcje

- **Auto-sync** — pobiera faktury z KSeF co 30min / 1h / 3h / 6h w tle
- **Wychodzące + Przychodzące** — osobne zakładki w tym samym arkuszu Google (Subject1 + Subject2)
- **Feed faktur przychodzących** — lista w stylu komunikatora z oznaczeniem nieprzeczytanych
- **Dashboard** — automatyczne podsumowania (netto, VAT, brutto, saldo) + 5 wykresów
- **Deduplikacja** — tylko nowe faktury trafiają do arkusza, nigdy duplikaty
- **Powiadomienia** — powiadomienia Chrome o nowych fakturach, wynikach synchronizacji, błędach
- **Szyfrowany sejf** — token KSeF zaszyfrowany PBKDF2 + AES-GCM, chroniony hasłem
- **Zapamiętaj hasło** — opcjonalnie, przetrwa restart przeglądarki dla auto-sync
- **Tryb ciemny** — motyw MUI, podąża za systemem lub ręczny przełącznik
- **i18n** — angielski + polski, przełączanie w ustawieniach
- **Przełącznik środowiska KSeF** — test / demo / produkcja
- **Test połączenia** — sprawdź czy token KSeF działa przed synchronizacją
- **Wybór arkusza** — wybierz do którego arkusza synchronizować lub utwórz nowy
- **Ikona statusu** — kolorowa kropka na ikonie rozszerzenia pokazuje stan synchronizacji
- **Pasek postępu** — wizualne odliczanie do następnej auto-synchronizacji
- **GPL-3.0** — wolne oprogramowanie, brak komercyjnego użycia bez udostępnienia kodu

## Szybki start

1. Zainstaluj rozszerzenie (Chrome Web Store / Firefox AMO — wkrótce)
2. Kliknij ikonę rozszerzenia → zakładka **Konfiguracja**
3. Wklej token KSeF (NIP wykryty automatycznie) → ustaw hasło → **Skonfiguruj sejf**
4. Połącz Google → autoryzuj dostęp do Arkuszy + Dysku
5. Przejdź do zakładki **Status** → **Synchronizuj teraz**
6. Otwórz link 📊 do arkusza, aby zobaczyć faktury + dashboard

## Rozwój

```bash
# Instalacja
npm install

# Budowanie Chrome
npm run build:chrome

# Testy (wymaga Docker)
npm run test:docker

# Załaduj w Chrome
# 1. chrome://extensions → Tryb programisty WŁ
# 2. Załaduj rozpakowane → wybierz dist/chrome/
```

## Licencja

GPL-3.0-or-later — zobacz [LICENSE](LICENSE)

**Autor:** k0ss11
