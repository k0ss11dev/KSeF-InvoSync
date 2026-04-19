#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Cross-browser Manifest V3 build. No Vite, no plugins — just esbuild and fs.
// Usage:
//   node scripts/build.mjs            → builds both Chrome and Firefox
//   node scripts/build.mjs chrome     → Chrome only
//   node scripts/build.mjs firefox    → Firefox only

import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src");
const OUT = resolve(ROOT, "dist");
const MANIFESTS = resolve(ROOT, "manifests");
const PUBLIC = resolve(ROOT, "public");

const BROWSERS = process.argv[2] ? [process.argv[2]] : ["chrome", "firefox"];

const env = await loadEnv();

for (const browser of BROWSERS) {
  await buildOne(browser);
}

console.log("\n✓ Build complete:", BROWSERS.map((b) => `dist/${b}`).join(", "));

// --------------------------------------------------------------------------

async function buildOne(browser) {
  if (!["chrome", "firefox"].includes(browser)) {
    throw new Error(`Unknown browser: ${browser} (expected chrome or firefox)`);
  }

  const outDir = resolve(OUT, browser);
  if (existsSync(outDir)) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(resolve(outDir, "popup"), { recursive: true });
  await mkdir(resolve(outDir, "background"), { recursive: true });
  await mkdir(resolve(outDir, "options"), { recursive: true });

  const isStoreBuild = process.env.BUILD_FOR_STORE === "1";

  const defines = {
    __GOOGLE_CLIENT_ID__: JSON.stringify(env.GOOGLE_CLIENT_ID),
    __GOOGLE_CLIENT_SECRET__: JSON.stringify(env.GOOGLE_CLIENT_SECRET),
    // Gate the SW test bridges: false in store builds so esbuild DCE strips
    // the entire `if (__TEST_BRIDGES__) { ... }` block (finding #1).
    __TEST_BRIDGES__: JSON.stringify(!isStoreBuild),
    // Production React build for store — smaller, faster, no dev warnings /
    // introspection surface (finding #2). Dev stays on "development" so
    // React DevTools + useful error messages work during testing.
    "process.env.NODE_ENV": JSON.stringify(isStoreBuild ? "production" : "development"),
  };

  const commonOptions = {
    bundle: true,
    format: "esm",
    target: ["es2022", "chrome120", "firefox121"],
    jsx: "automatic",
    // Store builds: full minification (whitespace + identifiers + syntax).
    // Dev builds: readable output but still DCE the __TEST_BRIDGES__ block.
    minify: isStoreBuild,
    minifySyntax: isStoreBuild,
    // Store builds: no sourcemap shipped to end users.
    // Dev builds: inline sourcemap for in-browser debugging.
    sourcemap: isStoreBuild ? false : "inline",
    define: defines,
    logLevel: "info",
  };

  // Popup (React + TSX) → dist/<browser>/popup/popup.js
  await esbuild.build({
    ...commonOptions,
    entryPoints: { popup: resolve(SRC, "popup/main.tsx") },
    outdir: resolve(outDir, "popup"),
    outExtension: { ".js": ".js" },
  });

  // Options page (React + TSX) → dist/<browser>/options/options.js
  await esbuild.build({
    ...commonOptions,
    entryPoints: { options: resolve(SRC, "options/main.tsx") },
    outdir: resolve(outDir, "options"),
    outExtension: { ".js": ".js" },
  });

  // Service worker → dist/<browser>/background/service-worker.js
  await esbuild.build({
    ...commonOptions,
    entryPoints: { "service-worker": resolve(SRC, "background/service-worker.ts") },
    outdir: resolve(outDir, "background"),
  });

  // Static HTML assets (CSS is bundled by esbuild from imports).
  await cp(resolve(SRC, "popup/index.html"), resolve(outDir, "popup/index.html"));
  await cp(resolve(SRC, "options/index.html"), resolve(outDir, "options/index.html"));

  // i18n locale files.
  await cp(resolve(SRC, "_locales"), resolve(outDir, "_locales"), { recursive: true });

  // Manifest (browser-specific).
  const manifestJson = JSON.parse(
    await readFile(resolve(MANIFESTS, `${browser}.json`), "utf8"),
  );
  // Inject the manifest "key" from a gitignored side-file (manifests/<browser>.key.local)
  // for local dev so the unpacked extension ID stays stable across reloads
  // (needed for OAuth redirect URI consistency). Chrome Web Store rejects
  // the "key" field on uploaded packages, so when BUILD_FOR_STORE=1 we
  // simply don't inject it.
  const keyFile = resolve(MANIFESTS, `${browser}.key.local`);
  if (!process.env.BUILD_FOR_STORE && existsSync(keyFile)) {
    const keyValue = (await readFile(keyFile, "utf8")).trim();
    if (keyValue) {
      // Insert "key" right after "default_locale" if present, else at the end.
      const ordered = {};
      for (const [k, v] of Object.entries(manifestJson)) {
        ordered[k] = v;
        if (k === "default_locale") ordered.key = keyValue;
      }
      if (!("key" in ordered)) ordered.key = keyValue;
      Object.keys(manifestJson).forEach((k) => delete manifestJson[k]);
      Object.assign(manifestJson, ordered);
    }
  }
  await writeFile(
    resolve(outDir, "manifest.json"),
    JSON.stringify(manifestJson, null, 2),
  );

  // Icons, if any.
  if (existsSync(resolve(PUBLIC, "icons"))) {
    await cp(resolve(PUBLIC, "icons"), resolve(outDir, "icons"), { recursive: true });
  }

  const credStatus = env.GOOGLE_CLIENT_ID
    ? "✓ GOOGLE_CLIENT_ID set"
    : "✗ GOOGLE_CLIENT_ID missing (OAuth will fail — see README)";
  console.log(`  → ${browser}: built (${credStatus})`);
}

async function loadEnv() {
  const out = { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" };
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return out;

  const content = await readFile(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key in out) out[key] = value;
  }
  return out;
}
