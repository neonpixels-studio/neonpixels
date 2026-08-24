import { describe, it, expect, vi, afterEach } from "vitest";

import cspReportHandler, {
  config,
} from "../../../netlify/functions/csp-report";

const LEGACY_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://neonpixels.io/",
    "effective-directive": "script-src-elem",
    "blocked-uri": "inline",
  },
};

const REPORTING_API_REPORT = {
  type: "csp-violation",
  body: { effectiveDirective: "script-src-elem", blockedURL: "inline" },
};

function postRequest(contentType: string, body: string) {
  return new Request("https://neonpixels.io/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("csp-report Netlify function", () => {
  it("is routed at the shared collector path", () => {
    expect(config.path).toBe("/csp-report");
  });

  it("accepts a valid report, replies 204 with an empty body, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.effectiveDirective).toBe("script-src-elem");
    expect(logged.blockedUri).toBe("inline");
  });

  it("logs each violation in a Reporting API batch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(
        REPORTING_API_CONTENT_TYPE,
        JSON.stringify([REPORTING_API_REPORT, REPORTING_API_REPORT]),
      ),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("logs an unparsed marker when a body parses but matches no report shape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify({ other: {} })),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("csp-report-unparsed");
  });

  it("logs nothing and replies 415 for an unsupported content type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest("application/json", JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(415);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs nothing and replies 400 for a malformed body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, "{ not json"),
    );

    expect(response.status).toBe(400);
    expect(warn).not.toHaveBeenCalled();
  });

  it("replies 405 with an Allow header for a non-POST request", async () => {
    const response = await cspReportHandler(
      new Request("https://neonpixels.io/csp-report", { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
