// Entry point for Playwright's webServer: serves the BUILT dist with the
// response headers the build generated (`_headers`). Run `npm run build` first.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readE2ePort } from "./e2ePort.ts";
import { loadServedHeaders } from "./enforcedCsp.ts";
import { createStaticServer } from "./staticServer.ts";

const DIST_DIR = resolve(process.cwd(), ".vitepress/dist");
const PORT = readE2ePort();

if (!existsSync(resolve(DIST_DIR, "index.html"))) {
  console.error(`No build found at ${DIST_DIR}; run "npm run build" first.`);
  process.exit(1);
}

const headers = loadServedHeaders(DIST_DIR);
createStaticServer(DIST_DIR, headers).listen(PORT, "127.0.0.1", () => {
  console.log(`Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
});
