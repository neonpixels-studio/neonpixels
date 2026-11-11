import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4321);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/support/serve.ts",
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse: a foreign server on this port would not send the CSP.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
