import {
  collectCspReports,
  CSP_REPORT_PATH,
  HTTP_BAD_REQUEST,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_PAYLOAD_TOO_LARGE,
  MAX_BODY_BYTES,
  POST_METHOD,
  type CollectorResult,
  type CspViolation,
} from "../../.vitepress/csp/cspReportCollector";
import { getCspReportStore } from "./lib/cspReportStore";

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
// Logged when the Blobs write itself fails (missing context, outage, etc.).
// Persistence failing must never fail the request or hide the violation —
// it's still visible in the function logs above, this only flags that the
// queryable copy didn't land.
const PERSIST_FAILED_LOG_PREFIX = "csp-report-persist-failed";
// Logged when one or more accepted violations were filtered out of the Blobs
// write (see isOwnOriginViolation). Without this marker, a run where the
// filter ate every violation would look identical in the store to a run with
// no violations at all — the same "silence must not read as clean" problem
// UNPARSED_LOG_PREFIX/REJECTED_LOG_PREFIX solve for the request-level path.
const PERSIST_SKIPPED_LOG_PREFIX = "csp-report-not-persisted";
const MAX_LOGGED_CONTENT_TYPE = 128;
// The Blobs write is a best-effort side effect of what browsers treat as a
// fire-and-forget beacon; cap how long we let it hold the response open so a
// slow/unavailable Blobs region degrades to a logged failure marker instead
// of turning a fast 204 into a function timeout the browser won't retry.
const PERSIST_TIMEOUT_MS = 3000;
// Fallback origin for contexts where Netlify hasn't injected URL/DEPLOY_PRIME_URL
// (a bare `netlify functions:invoke`, or this file's own unit tests).
const SITE_ORIGIN = "https://neonpixels.io";

// This is a noise filter, not an anti-forgery control: `documentUrl` comes
// from the request body, so a forger who reads the source can spoof any
// origin they like, including this site's. What it does buy: violations
// from misconfigured integrations, scanners, or a report sent to the wrong
// deploy never pollute the durable store the 'unsafe-inline' rollout gate
// reads, without touching what's logged to the console (which stays
// unfiltered — nothing is hidden, only the durable copy is narrowed).
// Netlify injects URL (the production domain) and DEPLOY_PRIME_URL (the
// running deploy's own URL — branch deploys, deploy previews, `netlify dev`)
// so this accepts every environment that can reach the endpoint, not just
// production; an env-derived allowlist also means a custom-domain change
// doesn't require a code change to keep persisting.
function allowedOrigins(): Set<string> {
  const candidates = [
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    SITE_ORIGIN,
  ];
  const origins = candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(originOf)
    .filter((origin): origin is string => origin !== null);
  return new Set(origins);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

class PersistTimeoutError extends Error {
  constructor() {
    super(`store write exceeded ${PERSIST_TIMEOUT_MS}ms`);
    this.name = "PersistTimeoutError";
  }
}

// Races `work` against a timeout, always clearing the timer so a fast/normal
// resolution doesn't leave a pending `setTimeout` on the event loop for the
// rest of PERSIST_TIMEOUT_MS.
async function withTimeout<Value>(work: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PersistTimeoutError()),
      PERSIST_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isOwnOriginViolation(violation: CspViolation): boolean {
  const origin = originOf(violation.documentUrl);
  return origin !== null && allowedOrigins().has(origin);
}

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

// Writes accepted, same-origin violations to the Blobs store in addition to
// the console log above, so the rollout signal is queryable rather than
// grep-only. A store failure (including a timeout) is logged, not thrown, so
// a Blobs outage degrades to log-only rather than turning every report into a
// 500. Skips the store entirely when there is nothing to persist, so a bot's
// 405, a rejected malformed body, or an off-origin forgery never emits a
// persist-failure marker into the rollout's "no rejection markers" window.
async function persistViolations(violations: CspViolation[]) {
  const ownOriginViolations = violations.filter(isOwnOriginViolation);
  const skipped = violations.length - ownOriginViolations.length;
  if (skipped > 0) {
    console.warn(PERSIST_SKIPPED_LOG_PREFIX, JSON.stringify({ skipped }));
  }
  if (ownOriginViolations.length === 0) {
    return;
  }
  try {
    await withTimeout(getCspReportStore().persist(ownOriginViolations));
  } catch (error) {
    console.warn(
      PERSIST_FAILED_LOG_PREFIX,
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// A 405 must advertise the methods it accepts (RFC 9110 §15.5.6).
function responseHeaders(status: number) {
  if (status === HTTP_METHOD_NOT_ALLOWED) {
    return { allow: POST_METHOD };
  }
  return undefined;
}

function isPost(request: Request) {
  return request.method.toUpperCase() === POST_METHOD;
}

// True when the client's declared body size already exceeds the cap, so the
// adapter answers 413 without buffering a hostile multi-megabyte payload.
function exceedsDeclaredSize(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES;
}

// Read the body defensively: an aborted or truncated upload rejects here, and an
// uncaught rejection would return a 500 with no log — the one lost-report path
// that produces no marker. Signal it as null so the caller answers 400 (logged).
async function readBody(request: Request) {
  try {
    return await request.text();
  } catch {
    return null;
  }
}

async function collect(
  request: Request,
  contentType: string | null,
): Promise<CollectorResult> {
  // Method first, so a non-POST always gets a 405 (with Allow) rather than a 413
  // from an oversize Content-Length it never had a report behind.
  if (!isPost(request)) {
    return { status: HTTP_METHOD_NOT_ALLOWED, violations: [], dropped: 0 };
  }
  if (exceedsDeclaredSize(request)) {
    return { status: HTTP_PAYLOAD_TOO_LARGE, violations: [], dropped: 0 };
  }
  const body = await readBody(request);
  if (body === null) {
    return { status: HTTP_BAD_REQUEST, violations: [], dropped: 0 };
  }
  return collectCspReports({ method: request.method, contentType, body });
}

export default async (request: Request): Promise<Response> => {
  const contentType = request.headers.get("content-type");
  const result = await collect(request, contentType);
  recordResult(result, contentType);
  // @todo This holds the response open for up to PERSIST_TIMEOUT_MS on a slow
  // Blobs write, which is billed function duration. If Netlify Functions v2
  // exposes a waitUntil-style background-work hook, move this off the
  // response path instead of racing it against a timeout.
  await persistViolations(result.violations);
  return new Response(null, {
    status: result.status,
    headers: responseHeaders(result.status),
  });
};

export const config = { path: CSP_REPORT_PATH };
