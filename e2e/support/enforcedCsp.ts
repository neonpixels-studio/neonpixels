import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALL_PATHS_GLOB,
  HEADERS_FILE_NAME,
  readGlobalHeaders,
} from "../../.vitepress/csp/headersFile.ts";

export { readGlobalHeaders };

// Reads the response headers straight out of the `_headers` file the build
// generated, so the e2e server sends exactly what Netlify sends in production.
// A hand-copied policy here would drift and let a real CSP regression pass.
const CSP_HEADER_NAME = "Content-Security-Policy";
const REPORTING_ENDPOINTS_HEADER_NAME = "Reporting-Endpoints";
const DEFAULT_DIST_DIR = resolve(process.cwd(), ".vitepress/dist");
// The e2e server sends violation reports to itself, so a failing run never posts
// to the real Sentry project; the page-side listener still fails the test.
export const LOCAL_REPORT_PATH = "/__csp-report";
const REPORT_URI_PATTERN = /(report-uri\s+)[^;]+/;
const REPORTING_ENDPOINT_PATTERN = /="[^"]*"/;

export function readEnforcedCsp(headersFile: string): string {
  const policy = readGlobalHeaders(headersFile)[CSP_HEADER_NAME];
  if (!policy) {
    throw new Error(
      `${HEADERS_FILE_NAME} has no enforcing ${CSP_HEADER_NAME} header for ${ALL_PATHS_GLOB}`,
    );
  }
  return policy;
}

export function loadGeneratedHeaders(distDir = DEFAULT_DIST_DIR) {
  const headersFile = readFileSync(resolve(distDir, HEADERS_FILE_NAME), "utf8");
  return readGlobalHeaders(headersFile);
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

export function loadServedHeaders(distDir = DEFAULT_DIST_DIR) {
  return localizeReporting(loadGeneratedHeaders(distDir));
}
