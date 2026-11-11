// Entry point for Playwright's webServer: serves the BUILT dist with the
// production CSP. Run `npm run build` first.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnforcedCsp } from "./enforcedCsp.ts";
import { createStaticServer } from "./staticServer.ts";

const DIST_DIR = resolve(process.cwd(), ".vitepress/dist");
const PORT = Number(process.env.E2E_PORT ?? 4321);

if (!existsSync(resolve(DIST_DIR, "index.html"))) {
  console.error(`No build found at ${DIST_DIR}; run "npm run build" first.`);
  process.exit(1);
}

const csp = loadEnforcedCsp();
createStaticServer(DIST_DIR, csp).listen(PORT, "127.0.0.1", () => {
  console.log(`Serving ${DIST_DIR} on http://127.0.0.1:${PORT}`);
});
