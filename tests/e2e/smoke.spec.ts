// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke: extension loads, popup renders without errors.

import { expect, test } from "./fixtures/extension";

test.describe("M0 smoke", () => {
  test("service worker registers with a valid extension ID", async ({
    serviceWorker,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain("service-worker.js");
  });

  test("popup renders without console errors", async ({
    context,
    extensionId,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);

    // New tabbed layout: Status + Config tabs visible
    await expect(page.getByRole("button", { name: /status/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /config/i })).toBeVisible();

    expect(consoleErrors, "popup should not log any errors").toEqual([]);
    expect(pageErrors, "popup should not throw any uncaught errors").toEqual([]);
  });
});
