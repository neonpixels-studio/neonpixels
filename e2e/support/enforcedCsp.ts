import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reads the response headers straight out of the `_headers` file the build
// generated, so the e2e server sends exactly what Netlify sends in production.
// A hand-copied policy here would drift and let a real CSP regression pass.
const CSP_HEADER_NAME = "Content-Security-Policy";
const HEADERS_FILE_NAME = "_headers";
const ALL_PATHS_GLOB = "/*";
const HEADER_LINE_PATTERN = /^\s+([\w-]+):[ \t]*(\S.*?)\s*$/;
const INDENTED_LINE_PATTERN = /^\s/;
const COMMENT_PREFIX = "#";

function isBlankOrComment(line: string) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith(COMMENT_PREFIX);
}

// An indented line is a header and an unindented one a path, as Netlify reads the
// file; an indented line that is not a `Name: value` pair is an error rather than
// being mistaken for a path, which would silently drop the block's other headers.
function parseHeaderLine(line: string) {
  const headerLine = HEADER_LINE_PATTERN.exec(line);
  if (!headerLine) {
    throw new Error(
      `${HEADERS_FILE_NAME}: not a valid header line: ${JSON.stringify(line)}`,
    );
  }
  return { name: headerLine[1], value: headerLine[2] };
}

// The headers of every block written for `/*`; blocks for other paths (cache
// rules for /assets/*) do not apply to a page response and are skipped. A header
// set twice for `/*` throws: Netlify would serve both values.
export function readGlobalHeaders(headersFile: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  let currentPath = "";
  for (const line of headersFile.split("\n")) {
    if (isBlankOrComment(line)) {
      continue;
    }
    if (!INDENTED_LINE_PATTERN.test(line)) {
      currentPath = line.trim();
      continue;
    }
    const { name, value } = parseHeaderLine(line);
    if (currentPath !== ALL_PATHS_GLOB) {
      continue;
    }
    if (seenNames.has(name.toLowerCase())) {
      throw new Error(
        `${HEADERS_FILE_NAME}: ${name} is set twice for ${ALL_PATHS_GLOB}`,
      );
    }
    seenNames.add(name.toLowerCase());
    headers[name] = value;
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
