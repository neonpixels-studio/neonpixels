import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeHeadersFile } from "@neon-pixels/security/netlify";

import {
  EXTRA_DENIED_FEATURES,
  SITE_DIRECTIVES,
  securityReportEndpoint,
} from "./sitePolicy";

const HEADERS_FILE_NAME = "_headers";
const HEADERS_PATH_GLOB = "/*";
const HEADER_INDENT = "  ";
const COMMENT_PREFIX = "#";
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
  const result = await writeHeadersFile(outDir, {
    directives: SITE_DIRECTIVES,
    reportEndpoint: securityReportEndpoint(environment),
    extraDeniedFeatures: EXTRA_DENIED_FEATURES,
    append: true,
  });
  await appendToPolicyBlock(outDir, extraHeaderLines);
  assertHeaderSizes(await readFile(result.path, "utf8"));
  return result;
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

function isPathLine(line: string) {
  const trimmed = line.trim();
  return (
    trimmed !== "" && !trimmed.startsWith(COMMENT_PREFIX) && !/^\s/.test(line)
  );
}

function headerName(line: string) {
  return line.slice(0, line.indexOf(":")).trim().toLowerCase();
}

// The package's block is the last one in the file and is written for `/*`, so
// an indented line appended to the file joins it. This keeps a single `/*`
// block instead of a second one whose merge behaviour Netlify does not
// document. Throws if that assumption stops holding, or if a line would set a
// header the block already sets (two values would both apply).
export async function appendToPolicyBlock(outDir: string, lines: string[]) {
  if (lines.length === 0) {
    return;
  }
  const headersPath = join(outDir, HEADERS_FILE_NAME);
  const existing = await readFile(headersPath, "utf8");
  const existingLines = existing.split("\n");
  const lastPathIndex = existingLines.map(isPathLine).lastIndexOf(true);
  const lastBlockPath = existingLines[lastPathIndex]?.trim();
  if (lastBlockPath !== HEADERS_PATH_GLOB) {
    throw new Error(
      `${HEADERS_FILE_NAME}: expected the last block to be "${HEADERS_PATH_GLOB}" before adding ${lines.join(", ")}, found ${JSON.stringify(lastBlockPath)}`,
    );
  }
  assertNoDuplicateNames(existingLines.slice(lastPathIndex + 1), lines);
  const separator = existing.endsWith("\n") ? "" : "\n";
  await appendFile(
    headersPath,
    `${separator}${lines.map((line) => `${HEADER_INDENT}${line}\n`).join("")}`,
  );
}

function assertNoDuplicateNames(blockLines: string[], newLines: string[]) {
  const names = blockLines.filter((line) => line.trim() !== "").map(headerName);
  const duplicates = newLines
    .map(headerName)
    .filter(
      (name, index, all) => names.includes(name) || all.indexOf(name) !== index,
    );
  if (duplicates.length === 0) {
    return;
  }
  throw new Error(
    `${HEADERS_FILE_NAME}: the "${HEADERS_PATH_GLOB}" block would set ${[...new Set(duplicates)].join(", ")} twice`,
  );
}
