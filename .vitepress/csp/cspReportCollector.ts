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

const POST_METHOD = "POST";
const LEGACY_CSP_REPORT_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";
const LEGACY_REPORT_KEY = "csp-report";
const CSP_VIOLATION_TYPE = "csp-violation";
const DEFAULT_DISPOSITION = "report";

const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;

const CONTENT_TYPE_PARAMETER_SEPARATOR = ";";

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
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" ? value : null;
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

function parseLegacyReports(payload: unknown): CspViolation[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  const report = asRecord(root[LEGACY_REPORT_KEY]);
  if (!report) {
    return [];
  }
  return [normalizeLegacyReport(report)];
}

function isCspViolationEntry(entry: Record<string, unknown>) {
  return entry.type === CSP_VIOLATION_TYPE;
}

function parseReportingApiReports(payload: unknown): CspViolation[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter(isCspViolationEntry)
    .map((entry) => asRecord(entry.body))
    .filter((body): body is Record<string, unknown> => body !== null)
    .map(normalizeReportingApiBody);
}

type ReportParser = (_payload: unknown) => CspViolation[];

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
    return { status: HTTP_METHOD_NOT_ALLOWED, violations: [] };
  }
  const parseReports = REPORT_PARSERS.get(normalizedContentType(contentType));
  if (!parseReports) {
    return { status: HTTP_UNSUPPORTED_MEDIA_TYPE, violations: [] };
  }
  const payload = parseJson(body);
  if (payload === PARSE_ERROR) {
    return { status: HTTP_BAD_REQUEST, violations: [] };
  }
  return { status: HTTP_NO_CONTENT, violations: parseReports(payload) };
}
