import { describe, it, expect } from "vitest";

import {
  collectCspReports,
  CSP_REPORT_PATH,
  CSP_REPORTING_GROUP,
  type CspReportRequest,
} from "../../csp/cspReportCollector";

const LEGACY_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";
const WEBKIT_JSON_CONTENT_TYPE = "application/json";

function cspRequest(contentType: string, body: unknown): CspReportRequest {
  return { method: "POST", contentType, body: JSON.stringify(body) };
}

function legacyRequest(body: unknown): CspReportRequest {
  return cspRequest(LEGACY_CONTENT_TYPE, body);
}

function reportingApiRequest(body: unknown): CspReportRequest {
  return cspRequest(REPORTING_API_CONTENT_TYPE, body);
}

function webkitJsonRequest(body: unknown): CspReportRequest {
  return cspRequest(WEBKIT_JSON_CONTENT_TYPE, body);
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
      contentType: "text/plain",
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

  it("accepts a body of exactly the byte cap", () => {
    // A valid legacy report padded to exactly 64 KiB of ASCII (1 byte/char).
    const prefix = `{"csp-report":{"script-sample":"`;
    const suffix = `"}}`;
    const padding = "x".repeat(64 * 1024 - prefix.length - suffix.length);
    const body = `${prefix}${padding}${suffix}`;
    expect(body).toHaveLength(64 * 1024);
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body,
    });
    expect(result.status).toBe(204);
  });

  it("measures the cap in bytes, not UTF-16 code units", () => {
    // 40 K astral chars = 40 K code units but ~160 KB of UTF-8 bytes.
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body: "😀".repeat(40 * 1024),
    });
    expect(result.status).toBe(413);
  });

  it("truncates a long free-text field rather than logging it whole", () => {
    const result = collectCspReports(
      legacyRequest({
        "csp-report": {
          "effective-directive": "script-src-elem",
          "script-sample": "a".repeat(1000),
        },
      }),
    );
    expect(result.violations[0].sample).toHaveLength(512);
  });

  it("drops a non-finite line number to null", () => {
    // `1e999` parses to Infinity (JSON.stringify would collapse it to null first).
    const result = collectCspReports({
      method: "POST",
      contentType: LEGACY_CONTENT_TYPE,
      body: `{"csp-report":{"effective-directive":"img-src","line-number":1e999}}`,
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
      legacyRequest({
        "csp-report": {
          "effective-directive": "script-src-elem",
          "blocked-uri": "eval",
        },
      }),
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

  it("drops a directive-less report instead of logging an empty violation", () => {
    const result = collectCspReports(
      legacyRequest({ "csp-report": { "blocked-uri": "inline" } }),
    );
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

  it("caps the batch at 20 violations and reports the excess as dropped", () => {
    // Minimal reports so 100 of them stay under the 64 KB body cap (which would
    // otherwise 413 before the per-batch cap is reached).
    const minimal = {
      type: "csp-violation",
      body: { effectiveDirective: "x" },
    };
    const batch = Array.from({ length: 100 }, () => minimal);
    const result = collectCspReports(reportingApiRequest(batch));
    expect(result.violations).toHaveLength(20);
    expect(result.dropped).toBe(80);
  });

  it("counts non-object array entries as dropped, not silently discarded", () => {
    const result = collectCspReports(
      reportingApiRequest(["oops", 42, REPORTING_API_REPORT]),
    );
    expect(result.violations).toHaveLength(1);
    expect(result.dropped).toBe(2);
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

describe("collectCspReports WebKit application/json", () => {
  it("accepts a legacy-shaped csp-report body sent as application/json", () => {
    const result = collectCspReports(webkitJsonRequest(LEGACY_REPORT));
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

  it("accepts a Reporting-API-shaped array body sent as application/json", () => {
    const result = collectCspReports(webkitJsonRequest([REPORTING_API_REPORT]));
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].effectiveDirective).toBe("script-src-elem");
  });

  it("accepts a content type carrying a charset", () => {
    const result = collectCspReports(
      cspRequest("application/json; charset=utf-8", LEGACY_REPORT),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(1);
  });

  it("drops a directive-less legacy-shaped report instead of logging an empty violation", () => {
    const result = collectCspReports(
      webkitJsonRequest({ "csp-report": { "blocked-uri": "inline" } }),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("rejects a csp-report key whose value isn't an object as a malformed body", () => {
    // One character away from the accepted shape ({"csp-report": "nope"} vs.
    // {"csp-report": {}}) — must not be treated as a legacy report that
    // happens to be empty (that would inflate `dropped` on organic noise).
    // application/json is still a supported content type, so this is a 400
    // (malformed body), not a 415 (unsupported type).
    const result = collectCspReports(
      webkitJsonRequest({ "csp-report": "nope" }),
    );
    expect(result.status).toBe(400);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("rejects a plain object with neither a csp-report key nor a violation array as a malformed body", () => {
    // application/json is the default content type of arbitrary bots/scanners,
    // unlike the two browser-only report types, so an unrecognized shape must
    // not be silently counted as a dropped report — that would poison the
    // csp-report-unparsed signal with unrelated JSON traffic. It's still a
    // supported content type, so the response is 400, not 415.
    const result = collectCspReports(webkitJsonRequest({ other: {} }));
    expect(result.status).toBe(400);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("rejects an array with no recognizable csp-violation entry as a malformed body", () => {
    const result = collectCspReports(webkitJsonRequest(["oops", 42, {}]));
    expect(result.status).toBe(400);
    expect(result.violations).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("rejects an empty array as a malformed body rather than an empty batch", () => {
    const result = collectCspReports(webkitJsonRequest([]));
    expect(result.status).toBe(400);
  });

  it.each([null, "nope", 5, true])(
    "rejects a scalar/null payload (%j) as a malformed body",
    (payload) => {
      const result = collectCspReports(webkitJsonRequest(payload));
      expect(result.status).toBe(400);
      expect(result.violations).toEqual([]);
      expect(result.dropped).toBe(0);
    },
  );

  it("ignores non-csp-violation entries mixed into the array rather than counting them as dropped", () => {
    // A genuine WebKit batch never contains alien entries; entries this
    // permissive filter can't identify as a report are excluded from the
    // shared parser entirely so one real entry can't be used to inflate
    // `dropped` with an unbounded number of siblings.
    const result = collectCspReports(
      webkitJsonRequest(["oops", 42, REPORTING_API_REPORT]),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });

  it("still drops a recognized csp-violation entry with a missing body", () => {
    const result = collectCspReports(
      webkitJsonRequest([{ type: "csp-violation" }, REPORTING_API_REPORT]),
    );
    expect(result.status).toBe(204);
    expect(result.violations).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });
});
