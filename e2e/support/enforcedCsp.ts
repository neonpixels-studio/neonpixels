import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseHeadersFile } from "../../.vitepress/csp/headersFile.ts";

// Reads the response headers straight out of the `_headers` file the build
// generated, so the e2e server sends exactly what Netlify sends in production.
// A hand-copied policy here would drift and let a real CSP regression pass.
const CSP_HEADER_NAME = "Content-Security-Policy";
const REPORTING_ENDPOINTS_HEADER_NAME = "Reporting-Endpoints";
const HEADERS_FILE_NAME = "_headers";
const ALL_PATHS_GLOB = "/*";
// The e2e server sends violation reports to itself, so a failing run never posts
// to the real Sentry project; the page-side listener still fails the test.
export const LOCAL_REPORT_PATH = "/__csp-report";
const REPORT_URI_PATTERN = /(report-uri\s+)[^\s;]+/;
const REPORTING_ENDPOINT_PATTERN = /="[^"]*"/;

// The headers of every block written for `/*`; blocks for other paths (cache
// rules for /assets/*) do not apply to a page response and are skipped. A header
// set twice for `/*` throws: Netlify would serve both values.
export function readGlobalHeaders(headersFile: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  const globalHeaders = parseHeadersFile(headersFile)
    .filter((block) => block.path === ALL_PATHS_GLOB)
    .flatMap((block) => block.headers);
  for (const { name, value } of globalHeaders) {
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

// The generated headers with every report destination pointed at the e2e server.
export function localizeReporting(headers: Record<string, string>) {
  const localized = { ...headers };
  const policy = localized[CSP_HEADER_NAME];
  if (policy) {
    localized[CSP_HEADER_NAME] = policy.replace(
      REPORT_URI_PATTERN,
      `$1${LOCAL_REPORT_PATH}`,
    );
  }
  const endpoints = localized[REPORTING_ENDPOINTS_HEADER_NAME];
  if (endpoints) {
    localized[REPORTING_ENDPOINTS_HEADER_NAME] = endpoints.replace(
      REPORTING_ENDPOINT_PATTERN,
      `="${LOCAL_REPORT_PATH}"`,
    );
  }
  return localized;
}

export function loadServedHeaders(
  distDir = resolve(process.cwd(), ".vitepress/dist"),
) {
  return localizeReporting(loadGeneratedHeaders(distDir));
}
