// SPDX-License-Identifier: GPL-3.0-or-later
// Shared Playwright fixture: launches Chromium with the built extension
// loaded from dist/chrome/ via a persistent (but fresh-per-run) user-data-dir,
// then waits for the extension's service worker to register and extracts its ID.
//
// Notes on persistence:
//  - For M0 / M1 tests we use a fresh mkdtemp directory per run so each test
//    starts from a clean slate and no stale storage leaks between runs.
//  - When we add Tier 4 "real credentials" tests (post-M1), we'll switch to a
//    fixed directory so cached Google session cookies survive and we don't
//    have to re-consent on every run. That's the tradeoff the user approved.

import {
  chromium,
  test as base,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXTENSION_PATH = resolve(__dirname, "../../../dist/chrome");

type Fixtures = {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(EXTENSION_PATH)) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. ` +
          `Run "npm run build:chrome" first.`,
      );
    }

    const userDataDir = mkdtempSync(resolve(tmpdir(), "ksef-bridge-test-"));
    // CONFIRMED 2026-04-11: headless mode does NOT work with MV3 extensions
    // in current Playwright + Chromium. Tested both `headless: true` and
    // `headless: true + --headless=new` — both fail with the SW never
    // registering. We use `headless: false` and rely on Xvfb (in Docker) or
    // tolerate brief popup windows (on local desktop) to keep tests headless
    // *to the user*. See README → "Running tests in Docker".
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    // COLD-START WARM-UP: on Windows, the FIRST context launched in a Node
    // process can take 30+ seconds to register the extension's service
    // worker, which blows the test timeout for whichever test happens to
    // run first (oauth-mocked, alphabetically). Forcing a page to open
    // pokes Chromium into fully initializing, and we wait up to 60 seconds
    // here (outside the per-test timeout) for the SW to actually register.
    // Subsequent contexts in the same run launch fast — this only matters
    // for the first one.
    const warmup = await context.newPage();
    await warmup.goto("about:blank");
    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent("serviceworker", { timeout: 60_000 });
    }
    await warmup.close();

    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    // The context fixture above guarantees the SW is registered by the
    // time we get here, so this is just a synchronous lookup in practice.
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    // chrome-extension://<id>/background/service-worker.js → <id>
    const id = serviceWorker.url().split("/")[2];
    await use(id);
  },
});

export { expect } from "@playwright/test";
