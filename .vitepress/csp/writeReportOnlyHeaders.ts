import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildReportOnlyCsp, collectInlineScriptHashes } from "./reportOnlyCsp";

// Build-time glue: reads the emitted HTML, hashes its inline scripts, and writes
// a Netlify `_headers` file carrying a Content-Security-Policy-Report-Only header
// into the publish dir. Runs from VitePress's buildEnd hook so the hashes are
// always derived from the real build output and can never silently drift. The
// enforcing CSP in netlify.toml is left untouched — this is the Report-Only
// rollout step, so a missed hash reports a violation without breaking the page.

const NETLIFY_CONFIG_URL = new URL("../../netlify.toml", import.meta.url);
const ENFORCING_CSP_PATTERN = /^\s*Content-Security-Policy\s*=\s*"([^"]*)"/gim;
const FILE_NOT_FOUND_CODE = "ENOENT";

const HTML_EXTENSION = ".html";
const HEADERS_FILE_NAME = "_headers";
const HEADERS_PATH_GLOB = "/*";
const REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";

async function readHtmlDocuments(outDir: string) {
  const entries = await readdir(outDir, {
    recursive: true,
    withFileTypes: true,
  });
  const htmlFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(HTML_EXTENSION),
  );
  return Promise.all(
    htmlFiles.map((entry) =>
      readFile(join(entry.parentPath, entry.name), "utf8"),
    ),
  );
}

async function readEnforcingCsp() {
  const netlifyConfig = await readFile(NETLIFY_CONFIG_URL, "utf8");
  const matches = [...netlifyConfig.matchAll(ENFORCING_CSP_PATTERN)];
  if (matches.length === 0 || !matches[0][1].trim()) {
    throw new Error(
      "CSP Report-Only: could not read the enforcing Content-Security-Policy from netlify.toml",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      "CSP Report-Only: netlify.toml declares multiple Content-Security-Policy headers; cannot decide which one the Report-Only header should mirror",
    );
  }
  return matches[0][1].trim();
}

function isFileNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === FILE_NOT_FOUND_CODE
  );
}

// The Report-Only rule shares its `/*` path with any hand-written `_headers`
// (VitePress copies public/_headers into the publish dir), so append rather than
// clobber. Netlify merges same-path rules, so both sets of headers still apply.
async function readExistingHeaders(headersPath: string) {
  try {
    return await readFile(headersPath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return "";
    }
    throw error;
  }
}

function mergeHeaders(existingHeaders: string, generatedHeaders: string) {
  const trimmed = existingHeaders.trim();
  if (!trimmed) {
    return generatedHeaders;
  }
  return `${trimmed}\n\n${generatedHeaders}`;
}

function formatHeadersFile(reportOnlyCsp: string) {
  return `${HEADERS_PATH_GLOB}\n  ${REPORT_ONLY_HEADER_NAME}: ${reportOnlyCsp}\n`;
}

export async function writeReportOnlyHeaders(outDir: string) {
  const htmlDocuments = await readHtmlDocuments(outDir);
  const scriptHashes = collectInlineScriptHashes(htmlDocuments);
  if (scriptHashes.length === 0) {
    throw new Error(
      "CSP Report-Only: no executable inline scripts found in the build output; refusing to emit a script-src that would silently mismatch",
    );
  }
  const reportOnlyCsp = buildReportOnlyCsp(
    await readEnforcingCsp(),
    scriptHashes,
  );
  const headersPath = join(outDir, HEADERS_FILE_NAME);
  const existingHeaders = await readExistingHeaders(headersPath);
  await writeFile(
    headersPath,
    mergeHeaders(existingHeaders, formatHeadersFile(reportOnlyCsp)),
    "utf8",
  );
}
