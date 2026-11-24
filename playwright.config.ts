import { defineConfig } from "@playwright/test";
import { createPlaywrightConfig } from "@neon-pixels/playwright-preset";
import { readE2ePort } from "./e2e/support/e2ePort.ts";

const SERVE_COMMAND = "node e2e/support/serve.ts";
const PORT = readE2ePort();
const base = createPlaywrightConfig({
  command: SERVE_COMMAND,
  port: PORT,
});

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  webServer: {
    command: SERVE_COMMAND,
    url: `http://localhost:${PORT}`,
    // Never reuse: a foreign server on this port would not send the CSP.
    reuseExistingServer: false,
  },
});
