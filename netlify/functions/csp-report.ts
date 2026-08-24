import {
  collectCspReports,
  CSP_REPORT_PATH,
  HTTP_PAYLOAD_TOO_LARGE,
  MAX_BODY_BYTES,
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
// Logged when a request is rejected outright (bad JSON, too large, unsupported
// type). Without it an unmodelled content type would read as "no violations",
// and the rollout would drop 'unsafe-inline' on false evidence.
const REJECTED_LOG_PREFIX = "csp-report-rejected";
const HTTP_BAD_REQUEST = 400;
const HTTP_METHOD_NOT_ALLOWED = 405;
const MAX_LOGGED_CONTENT_TYPE = 128;

// A rejected request carried a report we failed to record; a 405 is just a bot
// or crawler hitting the endpoint with the wrong method, not a lost report.
function isLostReport(status: number) {
  return status >= HTTP_BAD_REQUEST && status !== HTTP_METHOD_NOT_ALLOWED;
}

function loggableContentType(contentType: string | null) {
  return (contentType ?? "").slice(0, MAX_LOGGED_CONTENT_TYPE);
}

function recordResult(result: CollectorResult, contentType: string | null) {
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
  if (isLostReport(result.status)) {
    console.warn(
      REJECTED_LOG_PREFIX,
      JSON.stringify({
        status: result.status,
        contentType: loggableContentType(contentType),
      }),
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

// True when the client's declared body size already exceeds the cap, so the
// adapter answers 413 without buffering a hostile multi-megabyte payload.
function exceedsDeclaredSize(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES;
}

async function collect(
  request: Request,
  contentType: string | null,
): Promise<CollectorResult> {
  if (exceedsDeclaredSize(request)) {
    return { status: HTTP_PAYLOAD_TOO_LARGE, violations: [], dropped: 0 };
  }
  return collectCspReports({
    method: request.method,
    contentType,
    body: await request.text(),
  });
}

export default async (request: Request): Promise<Response> => {
  const contentType = request.headers.get("content-type");
  const result = await collect(request, contentType);
  recordResult(result, contentType);
  return new Response(null, {
    status: result.status,
    headers: responseHeaders(result.status),
  });
};

export const config = { path: CSP_REPORT_PATH };
