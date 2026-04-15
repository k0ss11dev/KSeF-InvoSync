// SPDX-License-Identifier: GPL-3.0-or-later
// Mocked OAuth tests — adapted for tabbed popup layout.

import { expect, test } from "./fixtures/extension";

const FAKE_EMAIL = "test-user@example.com";

test.describe("M0 mocked OAuth", () => {
  test.beforeEach(async ({ serviceWorker }) => {
    await serviceWorker.evaluate((fakeEmail) => {
      const originalFetch = self.fetch.bind(self);
      (self as unknown as { fetch: typeof fetch }).fetch = async (
        input: RequestInfo | URL, init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("oauth2/v3/userinfo")) {
          return new Response(JSON.stringify({ sub: "test-sub-12345", email: fakeEmail, email_verified: true }),
            { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("oauth2.googleapis.com/revoke")) {
          return new Response("", { status: 200 });
        }
        return originalFetch(input, init);
      };
    }, FAKE_EMAIL);
  });

  test("Config tab shows connected email when token is in storage", async ({
    context, serviceWorker, extensionId,
  }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        "google.token": { accessToken: "fake-access-token-for-test", expiresAt: Date.now() + 3600 * 1000 },
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.getByRole("button", { name: /config/i }).click();
    await expect(page.getByText(FAKE_EMAIL)).toBeVisible();
  });

  test("Disconnect clears token and hides email", async ({
    context, serviceWorker, extensionId,
  }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        "google.token": { accessToken: "fake-access-token-for-test", expiresAt: Date.now() + 3600 * 1000 },
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.getByRole("button", { name: /config/i }).click();
    await expect(page.getByText(FAKE_EMAIL)).toBeVisible();
    await page.getByRole("button", { name: /disconnect/i }).click();
    await expect(page.getByRole("button", { name: /connect google/i })).toBeVisible();

    const remaining = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get("google.token");
    });
    expect(remaining).toEqual({});
  });
});
