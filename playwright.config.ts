// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "unit",
      testMatch: /tests\/unit\/.*\.test\.ts$/,
    },
    {
      name: "e2e",
      testMatch: /tests\/e2e\/.*\.spec\.ts$/,
    },
  ],
});
