import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writeSiteHeaders } from "../../csp/writeSiteHeaders";

const HAND_WRITTEN_HEADERS_PATH = resolve(process.cwd(), "public/_headers");
const FIXTURE_PAGE =
  "<!doctype html><html><head><style>body{margin:0}</style></head><body><script>window.fixture = true;</script></body></html>";

// Runs the real header writer over a minimal built site (one inline script, one
// inline style, and the repo's hand-written public/_headers) and returns the
// `_headers` text it produced, so header assertions read the generated output
// instead of a hand-copied policy. A full build is not needed for anything but
// the hashes, which build-html.test.ts checks against the real pages.
export async function generateFixtureHeaders({
  environment = "production",
  extraHeaderLines = [] as string[],
} = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "np-generated-headers-"));
  try {
    await writeFile(join(outDir, "index.html"), FIXTURE_PAGE);
    await writeFile(
      join(outDir, "_headers"),
      await readFile(HAND_WRITTEN_HEADERS_PATH, "utf8"),
    );
    await writeSiteHeaders(outDir, { environment, extraHeaderLines });
    return await readFile(join(outDir, "_headers"), "utf8");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
