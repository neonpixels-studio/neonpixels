import { describe, it, expect } from "vitest";

import {
  collectCspReports,
  CSP_REPORT_PATH,
  CSP_REPORTING_GROUP,
  type CspReportRequest,
} from "../../csp/cspReportCollector";

const LEGACY_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";

function legacyRequest(body: unknown): CspReportRequest {
  return {
    method: "POST",
    contentType: LEGACY_CONTENT_TYPE,
    body: JSON.stringify(body),
  };
}

function reportingApiRequest(body: unknown): CspReportRequest {
  return {
    method: "POST",
    contentType: REPORTING_API_CONTENT_TYPE,
    body: JSON.stringify(body),
  };
}

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://neonpixels.io/",
    "effective-directive": "script-src-elem",
    "violated-directive": "script-src-elem",
    "blocked-uri": "inline",
    disposition: "report",
    "source-file": "https://neonpixels.io/",
    "line-number": 10,
    "column-number": 20,
    "script-sample": "boot()",
  },
};

const REPORTING_API_REPORT = {
  type: "csp-violation",
  url: "https://neonpixels.io/",
  body: {
    documentURL: "https://neonpixels.io/",
    effectiveDirective: "script-src-elem",
    blockedURL: "inline",
    disposition: "report",
    sourceFile: "https://neonpixels.io/",
    lineNumber: 10,
    columnNumber: 20,
    sample: "boot()",
  },
};

describe("collector endpoint identity", () => {
  it("exposes a same-origin collector path and a reporting group name", () => {
    expect(CSP_REPORT_PATH).toBe("/csp-report");
    expect(CSP_REPORTING_GROUP).toBe("csp-endpoint");
  });
});

describe("collectCspReports request guards", () => {
  it("rejects a non-POST method with 405", () => {
    const result = collectCspReports({
      method: "GET",
      contentType: LEGACY_CONTENT_TYPE,
      body: "",
    });
    expect(result.status).toBe(405);
    expect(result.violations).toEqual([]);
  });

  it("rejects an unrecognized content type with 415", () => {
    const result = collectCspReports({
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(LEGACY_REPORT),
    });
    expect(result.status).toBe(415);
    expect(result.violations).toEqual([]);
  });

  it("rejects a missing content type with 415", () => {
    const result = collectCspReports({
      method: "POST",
      contentType: null,
      body: JSON.stringify(LEGACY_REPORT),
    });
    expect(result.status).toBe(415);
  });

  it("rejects a malformed JSON body with 400", () => {
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body: "{ not json",
    });
    expect(result.status).toBe(400);
    expect(result.violations).toEqual([]);
  });

  it("rejects an over-sized body with 413 before parsing", () => {
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(result.status).toBe(413);
    expect(result.violations).toEqual([]);
  });

  it("truncates a long free-text field rather than logging it whole", () => {
    const result = collectCspReports(
      legacyRequest({
        "csp-report": { "script-sample": "a".repeat(1000) },
      }),
    );
    expect(result.violations[0].sample).toHaveLength(512);
  });

  it("drops a non-finite line number to null", () => {
    // `1e999` parses to Infinity (JSON.stringify would collapse it to null first).
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body: `{"csp-report":{"line-number":1e999}}`,
    });
    expect(result.violations[0].lineNumber).toBeNull();
  });

  it("accepts a lowercase method and a content type carrying a charset", () => {
    const result = collectCspReports({
      method: "post",
      contentType: "application/csp-report; charset=utf-8",
      body: JSON.stringify(LEGACY_REPORT),
    });
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(1);
  });
});

describe("collectCspReports legacy application/csp-report", () => {
  it("normalizes a single report into a violation", () => {
    const result = collectCspReports(legacyRequest(LEGACY_REPORT));
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([
      {
        documentUrl: "https://neonpixels.io/",
        effectiveDirective: "script-src-elem",
        blockedUri: "inline",
        disposition: "report",
        sourceFile: "https://neonpixels.io/",
        lineNumber: 10,
        columnNumber: 20,
        sample: "boot()",
      },
    ]);
  });

  it("falls back to violated-directive when effective-directive is absent", () => {
    const result = collectCspReports(
      legacyRequest({
        "csp-report": { "violated-directive": "img-src" },
      }),
    );
    expect(result.violations[0].effectiveDirective).toBe("img-src");
  });

  it("defaults disposition to report and missing numbers to null", () => {
    const result = collectCspReports(
      legacyRequest({ "csp-report": { "blocked-uri": "eval" } }),
    );
    expect(result.violations[0].disposition).toBe("report");
    expect(result.violations[0].lineNumber).toBeNull();
    expect(result.violations[0].columnNumber).toBeNull();
  });

  it("flags an unrecognized body shape as dropped rather than a silent 204", () => {
    const result = collectCspReports(legacyRequest({ other: {} }));
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});

describe("collectCspReports Reporting API application/reports+json", () => {
  it("normalizes each csp-violation report in the array", () => {
    const result = collectCspReports(
      reportingApiRequest([REPORTING_API_REPORT, REPORTING_API_REPORT]),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]).toEqual({
      documentUrl: "https://neonpixels.io/",
      effectiveDirective: "script-src-elem",
      blockedUri: "inline",
      disposition: "report",
      sourceFile: "https://neonpixels.io/",
      lineNumber: 10,
      columnNumber: 20,
      sample: "boot()",
    });
  });

  it("ignores non-csp-violation report types in the same batch", () => {
    const result = collectCspReports(
      reportingApiRequest([
        { type: "deprecation", body: {} },
        REPORTING_API_REPORT,
      ]),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].effectiveDirective).toBe("script-src-elem");
  });

  it("flags a csp-violation report with a missing body as dropped", () => {
    const result = collectCspReports(
      reportingApiRequest([{ type: "csp-violation" }]),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("treats a legitimately empty batch as zero dropped", () => {
    const result = collectCspReports(reportingApiRequest([]));
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("flags a non-array payload as dropped", () => {
    const result = collectCspReports(reportingApiRequest({ type: "x" }));
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});
