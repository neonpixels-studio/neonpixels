import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeHeadersFile } from "@neon-pixels/security/netlify";

import {
  ALL_PATHS_GLOB,
  HEADERS_FILE_NAME,
  parseHeadersFile,
  readGlobalHeaders,
} from "./headersFile";
import {
  EXTRA_DENIED_FEATURES,
  SITE_DIRECTIVES,
  securityReportEndpoint,
} from "./sitePolicy";

const HEADER_INDENT = "  ";
const FILE_NOT_FOUND_CODE = "ENOENT";
// A single header comfortably under the ~8 KB limit CDNs and origins enforce; the
// build fails loud here rather than letting Netlify truncate or reject at serve.
const MAX_HEADER_BYTES = 8000;
// A single `Name: value` pair with no line break: an extra header line is written
// into the `_headers` file verbatim, so an embedded newline could inject a second
// path block, and a value with no name could ship a malformed rule Netlify
// silently drops. `[ \t]*` (not `\s*`) after the colon, because `\s` also matches
// a line break.
const EXTRA_HEADER_LINE_PATTERN = /^[\w-]+:[ \t]*\S[^\r\n]*$/;

export type SiteHeadersOptions = {
  environment: string;
  // Extra `Name: value` lines for the `/*` block, such as the deploy-preview
  // noindex (see ../robots/getNoindexHeaderLines).
  extraHeaderLines: string[];
};

// Hashes the inline scripts and styles of the built pages and writes the
// enforced policy and the other security headers into the publish dir's
// `_headers` file, after the hand-written rules VitePress copied from public/.
// Throws the package's HeadersFileError when a page holds markup no hash can
// cover (an inline style attribute, an event handler, a javascript: URL).
export async function writeSiteHeaders(
  outDir: string,
  { environment, extraHeaderLines }: SiteHeadersOptions,
) {
  assertWellFormedHeaderLines(extraHeaderLines);
  const headersPath = join(outDir, HEADERS_FILE_NAME);
  const original = await readFileIfPresent(headersPath);
  try {
    const result = await writeHeadersFile(outDir, {
      directives: SITE_DIRECTIVES,
      reportEndpoint: securityReportEndpoint(environment),
      extraDeniedFeatures: EXTRA_DENIED_FEATURES,
      append: true,
    });
    await appendToPolicyBlock(outDir, extraHeaderLines);
    assertHeaderSizes(await readFile(headersPath, "utf8"));
    return result;
  } catch (error) {
    await restoreHeadersFile(headersPath, original);
    throw error;
  }
}

// A failed build must not leave a policy written without the lines that were meant
// to go with it, or a second run would fail on "already present" instead of on the
// real cause.
async function restoreHeadersFile(
  headersPath: string,
  original: string | null,
) {
  if (original === null) {
    await rm(headersPath, { force: true });
    return;
  }
  await writeFile(headersPath, original);
}

async function readFileIfPresent(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === FILE_NOT_FOUND_CODE) {
      return null;
    }
    throw error;
  });
}

function assertWellFormedHeaderLines(lines: string[]) {
  const malformed = lines.filter(
    (line) => !EXTRA_HEADER_LINE_PATTERN.test(line),
  );
  if (malformed.length === 0) {
    return;
  }
  throw new Error(
    `${HEADERS_FILE_NAME}: refusing to write malformed header line(s): ${malformed.map((line) => JSON.stringify(line)).join(", ")}`,
  );
}

function assertHeaderSizes(headersFile: string) {
  const oversized = headersFile
    .split("\n")
    .filter((line) => Buffer.byteLength(line) > MAX_HEADER_BYTES);
  if (oversized.length === 0) {
    return;
  }
  throw new Error(
    `${HEADERS_FILE_NAME}: ${oversized.length} header line(s) exceed ${MAX_HEADER_BYTES} bytes; split the policy per path`,
  );
}

// The package's block is the last one in the file and is written for `/*`, so
// an indented line appended to the file joins it. This keeps a single `/*`
// block instead of a second one whose merge behaviour Netlify does not
// document. Throws if that assumption stops holding, or if a line would set a
// header `/*` already sets (two values would both apply).
export async function appendToPolicyBlock(outDir: string, lines: string[]) {
  if (lines.length === 0) {
    return;
  }
  const headersPath = join(outDir, HEADERS_FILE_NAME);
  const existing = await readFile(headersPath, "utf8");
  const lastBlock = parseHeadersFile(existing).at(-1);
  if (lastBlock?.path !== ALL_PATHS_GLOB) {
    throw new Error(
      `${HEADERS_FILE_NAME}: expected the last block to be "${ALL_PATHS_GLOB}" before adding ${lines.join(", ")}, found ${JSON.stringify(lastBlock?.path)}`,
    );
  }
  const separator = existing.endsWith("\n") ? "" : "\n";
  const addition = lines.map((line) => `${HEADER_INDENT}${line}\n`).join("");
  readGlobalHeaders(`${existing}${separator}${addition}`);
  await appendFile(headersPath, `${separator}${addition}`);
}
