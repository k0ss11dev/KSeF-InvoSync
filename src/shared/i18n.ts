// SPDX-License-Identifier: GPL-3.0-or-later
// i18n with runtime locale switching. Supports manual PL/EN override
// independent of the browser's system locale.
//
// In the extension (bundled by esbuild): catalogs are inlined from JSON,
// t() resolves from the active locale.
// In unit tests (Node): catalogs may not load, t() falls back to the key.

export type Locale = "en" | "pl";

const LOCALE_KEY = "config.locale";

type MessageEntry = {
  message: string;
  placeholders?: Record<string, { content: string }>;
};
type MessageCatalog = Record<string, MessageEntry>;

// Catalogs loaded at module init. esbuild inlines JSON imports at bundle
// time. In Node test env this may fail — that's fine, t() falls back to key.
let CATALOGS: Record<string, MessageCatalog> = {};
try {
  // These imports are resolved by esbuild at bundle time. They're
  // wrapped in try/catch because Node's ESM loader rejects bare JSON
  // imports without `with { type: "json" }`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  CATALOGS = {
    en: require("../_locales/en/messages.json"),
    pl: require("../_locales/pl/messages.json"),
  };
} catch {
  // Running in Node test env — catalogs unavailable, t() returns key.
}

let activeLocale: Locale = detectDefaultLocale();

function detectDefaultLocale(): Locale {
  try {
    const lang = chrome?.i18n?.getUILanguage?.() ?? navigator?.language ?? "en";
    return lang.startsWith("pl") ? "pl" : "en";
  } catch {
    return "en";
  }
}

/**
 * Initialize locale from stored preference. Call once at app startup.
 */
export async function initLocale(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(LOCALE_KEY);
    const stored = result[LOCALE_KEY];
    if (stored === "pl" || stored === "en") {
      activeLocale = stored;
    }
  } catch {
    // Use detected default.
  }
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

export async function setLocale(locale: Locale): Promise<void> {
  activeLocale = locale;
  await chrome.storage.local.set({ [LOCALE_KEY]: locale });
}

/**
 * Return the localized string for `key`. Falls back to English, then to
 * the raw key name (useful in tests where catalogs aren't loaded).
 */
export function t(key: string, ...substitutions: string[]): string {
  const entry = CATALOGS[activeLocale]?.[key] ?? CATALOGS.en?.[key];
  if (!entry) return key;

  let msg = entry.message;

  // Resolve named placeholders: $name$ → placeholder.content ($1/$2/etc) → substitution value.
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      // ph.content is typically "$1", "$2", etc.
      const idx = parseInt(ph.content.replace("$", ""), 10) - 1;
      const value = substitutions[idx] ?? ph.content;
      // Replace $name$ (case-insensitive, per chrome.i18n spec)
      msg = msg.replace(new RegExp(`\\$${name}\\$`, "gi"), value);
    }
  }

  // Also replace bare $1, $2 for messages that use them directly.
  for (let i = 0; i < substitutions.length; i++) {
    msg = msg.replaceAll(`$${i + 1}`, substitutions[i]);
  }
  return msg;
}
