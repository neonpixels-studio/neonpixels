import { defineConfig } from "@playwright/test";
import { createPlaywrightConfig } from "@neon-pixels/playwright-preset";
import { readE2ePort } from "./e2e/support/e2ePort.ts";

const SERVE_COMMAND = "node e2e/support/serve.ts";
const PORT = readE2ePort();
const base = createPlaywrightConfig({
  command: SERVE_COMMAND,
  port: PORT,
});

// serve.ts listens on 127.0.0.1 only; the preset's `localhost` could resolve to ::1.
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: BASE_URL },
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  webServer: {
    command: SERVE_COMMAND,
    url: BASE_URL,
    // Never reuse: a foreign server on this port would not send the CSP.
    reuseExistingServer: false,
  },
});
