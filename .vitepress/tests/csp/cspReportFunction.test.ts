import { describe, it, expect, vi, afterEach } from "vitest";

import cspReportHandler, {
  config,
} from "../../../netlify/functions/csp-report";

const LEGACY_CONTENT_TYPE = "application/csp-report";

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://neonpixels.io/",
    "effective-directive": "script-src-elem",
    "blocked-uri": "inline",
  },
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

  it("accepts a valid report and replies 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.effectiveDirective).toBe("script-src-elem");
    expect(logged.blockedUri).toBe("inline");
  });

  it("logs nothing and replies 415 for an unsupported content type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest("application/json", JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(415);
    expect(warn).not.toHaveBeenCalled();
  });

  it("replies 405 for a non-POST request", async () => {
    const response = await cspReportHandler(
      new Request("https://neonpixels.io/csp-report", { method: "GET" }),
    );
    expect(response.status).toBe(405);
  });
});
