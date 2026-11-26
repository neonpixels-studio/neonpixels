import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reads the response headers straight out of the `_headers` file the build
// generated, so the e2e server sends exactly what Netlify sends in production.
// A hand-copied policy here would drift and let a real CSP regression pass.
const CSP_HEADER_NAME = "Content-Security-Policy";
const HEADERS_FILE_NAME = "_headers";
const ALL_PATHS_GLOB = "/*";
const HEADER_LINE_PATTERN = /^\s+([\w-]+):[ \t]*(\S.*?)\s*$/;
const COMMENT_PREFIX = "#";

// The headers of every block written for `/*`; blocks for other paths (cache
// rules for /assets/*) do not apply to a page response and are skipped. The
// package's policy block and the hand-written rules are separate blocks.
export function readGlobalHeaders(headersFile: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentPath = "";
  for (const line of headersFile.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith(COMMENT_PREFIX)) {
      continue;
    }
    const headerLine = HEADER_LINE_PATTERN.exec(line);
    if (!headerLine) {
      currentPath = line.trim();
      continue;
    }
    if (currentPath === ALL_PATHS_GLOB) {
      headers[headerLine[1]] = headerLine[2];
    }
  }
  return headers;
}

export function readEnforcedCsp(headersFile: string): string {
  const policy = readGlobalHeaders(headersFile)[CSP_HEADER_NAME];
  if (!policy) {
    throw new Error(
      `${HEADERS_FILE_NAME} has no enforcing ${CSP_HEADER_NAME} header for ${ALL_PATHS_GLOB}`,
    );
  }
  return policy;
}

export function loadGeneratedHeaders(
  distDir = resolve(process.cwd(), ".vitepress/dist"),
) {
  return readGlobalHeaders(
    readFileSync(resolve(distDir, HEADERS_FILE_NAME), "utf8"),
  );
}

export function loadEnforcedCsp(
  distDir = resolve(process.cwd(), ".vitepress/dist"),
) {
  return readEnforcedCsp(
    readFileSync(resolve(distDir, HEADERS_FILE_NAME), "utf8"),
  );
}
