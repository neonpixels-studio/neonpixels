import {
  collectCspReports,
  CSP_REPORT_PATH,
  POST_METHOD,
  type CollectorResult,
  type CspViolation,
} from "../../.vitepress/csp/cspReportCollector";

// Netlify Function (v2, web-standard Request/Response) that gathers the CSP
// violations the Report-Only header sends here, so they land in the function
// logs instead of only the browser console. All parsing/validation lives in
// cspReportCollector so this adapter stays a thin seam: read the request, hand
// it to the pure collector, record what it returns, reply with the status.

const VIOLATION_LOG_PREFIX = "csp-violation";
// Logged when a body parsed as JSON but matched no known report shape, so a
// browser format the parsers miss is visible rather than a silent clean 204.
const UNPARSED_LOG_PREFIX = "csp-report-unparsed";
const HTTP_METHOD_NOT_ALLOWED = 405;

function recordResult(result: CollectorResult) {
  for (const violation of result.violations) {
    // console output is the collection sink: Netlify captures it in the
    // function logs, where the rollout can watch for genuine script-src drift.
    logViolation(violation);
  }
  if (result.dropped > 0) {
    console.warn(
      UNPARSED_LOG_PREFIX,
      JSON.stringify({ dropped: result.dropped }),
    );
  }
}

function logViolation(violation: CspViolation) {
  console.warn(VIOLATION_LOG_PREFIX, JSON.stringify(violation));
}

// A 405 must advertise the methods it accepts (RFC 9110 §15.5.6).
function responseHeaders(status: number) {
  if (status === HTTP_METHOD_NOT_ALLOWED) {
    return { allow: POST_METHOD };
  }
  return undefined;
}

export default async (request: Request): Promise<Response> => {
  const result = collectCspReports({
    method: request.method,
    contentType: request.headers.get("content-type"),
    body: await request.text(),
  });
  recordResult(result);
  return new Response(null, {
    status: result.status,
    headers: responseHeaders(result.status),
  });
};

export const config = { path: CSP_REPORT_PATH };
