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

// Hashes the inline scripts and styles of the built pages and writes the
// enforced policy and the other security headers into the publish dir's
// `_headers` file, after the hand-written rules VitePress copied from public/.
// Throws the package's HeadersFileError when a page holds markup no hash can
// cover (an inline style attribute, an event handler, a javascript: URL).
export async function writeSiteHeaders(
  outDir: string,
  { environment, extraHeaderLines }: SiteHeadersOptions,
) {
  const result = await writeHeadersFile(outDir, {
    directives: SITE_DIRECTIVES,
    reportEndpoint: securityReportEndpoint(environment),
    extraDeniedFeatures: EXTRA_DENIED_FEATURES,
    append: true,
  });
  await appendToPolicyBlock(outDir, extraHeaderLines);
  return result;
}

export type SiteHeadersOptions = {
  environment: string;
  // Extra `Name: value` lines for the `/*` block, such as the deploy-preview
  // noindex (see ../robots/getNoindexHeaderLines).
  extraHeaderLines: string[];
};

// The package's block is the last one in the file and is written for `/*`, so
// an indented line appended to the file joins it. This keeps a single `/*`
// block instead of a second one whose merge behaviour Netlify does not
// document. Throws if that assumption stops holding.
export async function appendToPolicyBlock(outDir: string, lines: string[]) {
  if (lines.length === 0) {
    return;
  }
  const headersPath = join(outDir, HEADERS_FILE_NAME);
  const lastBlockPath = lastPathLine(await readFile(headersPath, "utf8"));
  if (lastBlockPath !== HEADERS_PATH_GLOB) {
    throw new Error(
      `${HEADERS_FILE_NAME}: expected the last block to be "${HEADERS_PATH_GLOB}" before adding ${lines.join(", ")}, found ${JSON.stringify(lastBlockPath)}`,
    );
  }
  await appendFile(
    headersPath,
    lines.map((line) => `${HEADER_INDENT}${line}\n`).join(""),
  );
}

function lastPathLine(headers: string) {
  const pathLines = headers
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s/.test(line));
  return pathLines.at(-1)?.trim();
}
