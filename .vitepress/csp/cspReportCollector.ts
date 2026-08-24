// Pure request-handling logic for the CSP violation collector. Nothing here
// touches Netlify, the filesystem, or the network, so the parsing and routing
// can be unit-tested in isolation; the runtime adapter lives in
// netlify/functions/csp-report.ts and only translates a web Request/Response
// around this. Browsers deliver violations in two shapes: the deprecated
// `application/csp-report` body (one report under a `csp-report` key) and the
// modern Reporting API `application/reports+json` body (an array of reports);
// both are normalized to a single CspViolation shape so downstream logging is
// format-agnostic.

// The same-origin route the collector is served from. Shared with the Netlify
// function (its `config.path`) and the Report-Only header wiring so the endpoint
// is declared in exactly one place.
export const CSP_REPORT_PATH = "/csp-report";
// The Reporting-Endpoints group name the `report-to` directive points at.
export const CSP_REPORTING_GROUP = "csp-endpoint";

// The one method the collector answers; exported so the adapter can set the
// `Allow` header a 405 requires without re-declaring the literal.
export const POST_METHOD = "POST";
const LEGACY_CSP_REPORT_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";
const LEGACY_REPORT_KEY = "csp-report";
const CSP_VIOLATION_TYPE = "csp-violation";
const DEFAULT_DISPOSITION = "report";

// Exported so the adapter shares one source of truth for the status contract
// rather than re-declaring codes it has to keep in sync with this module.
export const HTTP_NO_CONTENT = 204;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_METHOD_NOT_ALLOWED = 405;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;

const CONTENT_TYPE_PARAMETER_SEPARATOR = ";";

// The endpoint is public and unauthenticated, so bound the request size, each
// free-text field, and the batch count: a genuine violation report is small
// (well under 64 KB) and a real page produces a handful of distinct violations,
// so these caps keep a crafted payload from flooding the function logs the
// reports are gathered into. MAX_BODY_BYTES is exported so the adapter can
// reject an oversize request by its Content-Length before buffering.
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 512;
const MAX_VIOLATIONS_PER_REQUEST = 20;

const textEncoder = new TextEncoder();

function byteLength(body: string) {
  return textEncoder.encode(body).length;
}

// A JSON.parse that failed, kept distinct from any legitimate parsed value
// (including null) so the caller can tell a malformed body from valid `null`.
const PARSE_ERROR = Symbol("csp-report-parse-error");

export type CspViolation = {
  documentUrl: string;
  effectiveDirective: string;
  blockedUri: string;
  disposition: string;
  sourceFile: string;
  lineNumber: number | null;
  columnNumber: number | null;
  sample: string;
};

export type CspReportRequest = {
  method: string;
  contentType: string | null;
  body: string;
};

export type CollectorResult = {
  status: number;
  violations: CspViolation[];
  // Report-shaped payloads that parsed as JSON but could not be normalized into a
  // violation. Surfaced so the adapter logs a distinct marker rather than
  // returning the same silent 204 a genuinely empty batch does — a browser format
  // the parsers miss must not read as "policy clean" (fail loud).
  dropped: number;
};

type ParsedReports = { violations: CspViolation[]; dropped: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    return "";
  }
  // Truncate on code points so the cap never leaves a lone surrogate that would
  // serialize as a bare `\ud83d` escape in the log line.
  return [...value].slice(0, MAX_FIELD_LENGTH).join("");
}

// Reject NaN/Infinity (both `typeof === "number"`, reachable via a crafted body
// or `1e999`) so a field the type calls a number never logs as `null`.
function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The deprecated report body carries hyphenated keys and folds the effective
// directive under `violated-directive` on older engines, so fall back to it.
function normalizeLegacyReport(report: Record<string, unknown>): CspViolation {
  return {
    documentUrl: readString(report, "document-uri"),
    effectiveDirective:
      readString(report, "effective-directive") ||
      readString(report, "violated-directive"),
    blockedUri: readString(report, "blocked-uri"),
    disposition: readString(report, "disposition") || DEFAULT_DISPOSITION,
    sourceFile: readString(report, "source-file"),
    lineNumber: readNumber(report, "line-number"),
    columnNumber: readNumber(report, "column-number"),
    sample: readString(report, "script-sample"),
  };
}

// The Reporting API body uses camelCase keys nested under `body`.
function normalizeReportingApiBody(
  body: Record<string, unknown>,
): CspViolation {
  return {
    documentUrl: readString(body, "documentURL"),
    effectiveDirective: readString(body, "effectiveDirective"),
    blockedUri: readString(body, "blockedURL"),
    disposition: readString(body, "disposition") || DEFAULT_DISPOSITION,
    sourceFile: readString(body, "sourceFile"),
    lineNumber: readNumber(body, "lineNumber"),
    columnNumber: readNumber(body, "columnNumber"),
    sample: readString(body, "sample"),
  };
}

// A real browser report always names the directive it breached, so a normalized
// violation with no effective directive is noise (or forgery) and is not logged.
function isUsableViolation(violation: CspViolation) {
  return violation.effectiveDirective !== "";
}

// Drop directive-less candidates and cap the batch, folding both the unusable
// and the over-cap excess into `dropped` so nothing is silently discarded.
function finalizeViolations(
  candidates: CspViolation[],
  droppedBefore: number,
): ParsedReports {
  const usable = candidates.filter(isUsableViolation);
  const violations = usable.slice(0, MAX_VIOLATIONS_PER_REQUEST);
  const unusable = candidates.length - usable.length;
  const overCap = usable.length - violations.length;
  return { violations, dropped: droppedBefore + unusable + overCap };
}

function parseLegacyReports(payload: unknown): ParsedReports {
  const root = asRecord(payload);
  if (!root) {
    return { violations: [], dropped: 1 };
  }
  const report = asRecord(root[LEGACY_REPORT_KEY]);
  if (!report) {
    return { violations: [], dropped: 1 };
  }
  return finalizeViolations([normalizeLegacyReport(report)], 0);
}

function isCspViolationEntry(entry: Record<string, unknown>) {
  return entry.type === CSP_VIOLATION_TYPE;
}

function parseReportingApiReports(payload: unknown): ParsedReports {
  if (!Array.isArray(payload)) {
    return { violations: [], dropped: 1 };
  }
  const entries = payload.map(asRecord);
  const malformedEntries = entries.filter((entry) => entry === null).length;
  const bodies = entries
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter(isCspViolationEntry)
    .map((entry) => asRecord(entry.body));
  const candidates = bodies
    .filter((body): body is Record<string, unknown> => body !== null)
    .map(normalizeReportingApiBody);
  const missingBodies = bodies.filter((body) => body === null).length;
  return finalizeViolations(candidates, malformedEntries + missingBodies);
}

type ReportParser = (_payload: unknown) => ParsedReports;

const REPORT_PARSERS = new Map<string, ReportParser>([
  [LEGACY_CSP_REPORT_CONTENT_TYPE, parseLegacyReports],
  [REPORTING_API_CONTENT_TYPE, parseReportingApiReports],
]);

// The bare media type, lowercased, with any parameters (`; charset=utf-8`)
// stripped so `application/reports+json; charset=utf-8` still routes.
function normalizedContentType(contentType: string | null) {
  return (contentType ?? "")
    .split(CONTENT_TYPE_PARAMETER_SEPARATOR)[0]
    .trim()
    .toLowerCase();
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return PARSE_ERROR;
  }
}

// Validate the request, parse whichever report format was sent, and return the
// normalized violations plus the HTTP status the adapter should reply with:
// 405 for a non-POST, 415 for an unrecognized content type, 400 for a malformed
// body, 204 once the reports are accepted.
export function collectCspReports({
  method,
  contentType,
  body,
}: CspReportRequest): CollectorResult {
  if (method.toUpperCase() !== POST_METHOD) {
    return { status: HTTP_METHOD_NOT_ALLOWED, violations: [], dropped: 0 };
  }
  const parseReports = REPORT_PARSERS.get(normalizedContentType(contentType));
  if (!parseReports) {
    return { status: HTTP_UNSUPPORTED_MEDIA_TYPE, violations: [], dropped: 0 };
  }
  if (byteLength(body) > MAX_BODY_BYTES) {
    return { status: HTTP_PAYLOAD_TOO_LARGE, violations: [], dropped: 0 };
  }
  const payload = parseJson(body);
  if (payload === PARSE_ERROR) {
    return { status: HTTP_BAD_REQUEST, violations: [], dropped: 0 };
  }
  const { violations, dropped } = parseReports(payload);
  return { status: HTTP_NO_CONTENT, violations, dropped };
}
