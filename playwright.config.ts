import { defineConfig } from "@playwright/test";
import { createPlaywrightConfig } from "@neon-pixels/playwright-preset";
import { readE2ePort } from "./e2e/support/e2ePort.ts";

const PORT = readE2ePort();
const base = createPlaywrightConfig({
  command: "node e2e/support/serve.ts",
  port: PORT,
});

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  webServer: {
    ...base.webServer,
    command: "node e2e/support/serve.ts",
    // Never reuse: a foreign server on this port would not send the CSP.
    reuseExistingServer: false,
  },
});
