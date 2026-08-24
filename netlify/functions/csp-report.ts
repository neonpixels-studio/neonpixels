import {
  collectCspReports,
  CSP_REPORT_PATH,
  type CspViolation,
} from "../../.vitepress/csp/cspReportCollector";

// Netlify Function (v2, web-standard Request/Response) that gathers the CSP
// violations the Report-Only header sends here, so they land in the function
// logs instead of only the browser console. All parsing/validation lives in
// cspReportCollector so this adapter stays a thin seam: read the request, hand
// it to the pure collector, record what it returns, reply with the status.

const VIOLATION_LOG_PREFIX = "csp-violation";

function recordViolations(violations: CspViolation[]) {
  for (const violation of violations) {
    // console output is the collection sink: Netlify captures it in the
    // function logs, where the rollout can watch for genuine script-src drift.
    console.warn(VIOLATION_LOG_PREFIX, JSON.stringify(violation));
  }
}

export default async (request: Request): Promise<Response> => {
  const result = collectCspReports({
    method: request.method,
    contentType: request.headers.get("content-type"),
    body: await request.text(),
  });
  recordViolations(result.violations);
  return new Response(null, { status: result.status });
};

export const config = { path: CSP_REPORT_PATH };
