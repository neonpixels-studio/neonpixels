import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The store write is a separate, independently-tested unit (see
// cspReportStore.test.ts); mocking it here keeps this file about the
// adapter's request/response and logging behavior, not Blobs itself.
// getCspReportStoreMock is its own mock (not just a passthrough to
// persistMock) so a test can make getCspReportStore() itself throw
// synchronously, the way the real client does when the Blobs context is
// missing (see "logs a persist-failure marker when the store is unavailable").
const { persistMock, getCspReportStoreMock } = vi.hoisted(() => ({
  persistMock: vi.fn(),
  getCspReportStoreMock: vi.fn(),
}));
vi.mock("../../../netlify/functions/lib/cspReportStore", () => ({
  getCspReportStore: getCspReportStoreMock,
}));

import cspReportHandler, {
  config,
  PERSIST_TIMEOUT_MS,
} from "../../../netlify/functions/csp-report";

const LEGACY_CONTENT_TYPE = "application/csp-report";
const REPORTING_API_CONTENT_TYPE = "application/reports+json";
const PERSIST_FAILED_LOG_PREFIX = "csp-report-persist-failed";
const PERSIST_SKIPPED_LOG_PREFIX = "csp-report-not-persisted";

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://neonpixels.io/",
    "effective-directive": "script-src-elem",
    "blocked-uri": "inline",
  },
};

const REPORTING_API_REPORT = {
  type: "csp-violation",
  body: {
    documentURL: "https://neonpixels.io/",
    effectiveDirective: "script-src-elem",
    blockedURL: "inline",
  },
};

function postRequest(contentType: string, body: string) {
  return new Request("https://neonpixels.io/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

beforeEach(() => {
  persistMock.mockReset().mockResolvedValue(undefined);
  getCspReportStoreMock.mockReset().mockReturnValue({ persist: persistMock });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("replies 415 and logs a rejection marker for an unsupported content type", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest("text/plain", JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(415);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("csp-report-rejected");
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.status).toBe(415);
    expect(logged.contentType).toBe("text/plain");
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("accepts a WebKit-style legacy-shaped report sent as application/json", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest("application/json", JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.effectiveDirective).toBe("script-src-elem");
    expect(logged.blockedUri).toBe("inline");
  });

  it("replies 400 and logs a rejection marker for a malformed body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, "{ not json"),
    );

    expect(response.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("csp-report-rejected");
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("replies 413 from the Content-Length without buffering the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A real Request recomputes Content-Length from its body, so use a stub to
    // prove the oversize declaration short-circuits before request.text() runs.
    const text = vi.fn();
    const request = {
      method: "POST",
      headers: new Headers({
        "content-type": LEGACY_CONTENT_TYPE,
        "content-length": String(64 * 1024 + 1),
      }),
      text,
    } as unknown as Request;

    const response = await cspReportHandler(request);

    expect(response.status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toBe("csp-report-rejected");
  });

  it("replies 405 with an Allow header and logs nothing for a non-POST request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      new Request("https://neonpixels.io/csp-report", { method: "GET" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(warn).not.toHaveBeenCalled();
  });

  it("replies 405 for a non-POST even when it declares an oversize body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = {
      method: "GET",
      headers: new Headers({ "content-length": String(64 * 1024 + 1) }),
      text: vi.fn(),
    } as unknown as Request;

    const response = await cspReportHandler(request);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(warn).not.toHaveBeenCalled();
  });

  it("replies 400 and logs a rejection when the body read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = {
      method: "POST",
      headers: new Headers({ "content-type": LEGACY_CONTENT_TYPE }),
      text: vi.fn().mockRejectedValue(new Error("aborted")),
    } as unknown as Request;

    const response = await cspReportHandler(request);

    expect(response.status).toBe(400);
    expect(warn.mock.calls[0][0]).toBe("csp-report-rejected");
  });

  it("persists an accepted violation to the store", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(persistMock).toHaveBeenCalledTimes(1);
    const [persisted] = persistMock.mock.calls[0] as [
      { effectiveDirective: string; blockedUri: string }[],
    ];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].effectiveDirective).toBe("script-src-elem");
    expect(persisted[0].blockedUri).toBe("inline");
  });

  it("persists every violation in a Reporting API batch in one call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await cspReportHandler(
      postRequest(
        REPORTING_API_CONTENT_TYPE,
        JSON.stringify([REPORTING_API_REPORT, REPORTING_API_REPORT]),
      ),
    );

    expect(persistMock).toHaveBeenCalledTimes(1);
    const [persisted] = persistMock.mock.calls[0] as [unknown[]];
    expect(persisted).toHaveLength(2);
  });

  it("still replies normally and logs a marker when the store write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    persistMock.mockRejectedValueOnce(new Error("blobs unavailable"));

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(204);
    const failureCall = warn.mock.calls.find(
      (call) => call[0] === PERSIST_FAILED_LOG_PREFIX,
    );
    expect(failureCall).toBeDefined();
    const logged = JSON.parse(failureCall?.[1] as string);
    expect(logged.message).toBe("blobs unavailable");
    expect(logged.count).toBe(1);
  });

  it("logs a persist-failure marker when the store is unavailable", async () => {
    // getStore() throws synchronously when the Blobs context is missing (a
    // bare `netlify functions:invoke` without a linked site) — this must
    // stay inside persistViolations's try/catch, not hoisted above it, or a
    // missing context turns every CSP report into an unhandled exception
    // instead of a logged, non-fatal marker.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getCspReportStoreMock.mockImplementationOnce(() => {
      throw new Error("missing blobs context");
    });

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(response.status).toBe(204);
    const failureCall = warn.mock.calls.find(
      (call) => call[0] === PERSIST_FAILED_LOG_PREFIX,
    );
    expect(failureCall).toBeDefined();
    const logged = JSON.parse(failureCall?.[1] as string);
    expect(logged.message).toBe("missing blobs context");
  });

  it("never touches the store when there are no violations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await cspReportHandler(
      new Request("https://neonpixels.io/csp-report", { method: "GET" }),
    );

    expect(response.status).toBe(405);
    expect(persistMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a persist-failure marker and still replies normally when the store write hangs past the timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Resolve `entered` once persist() is actually invoked, so the timer
    // advance below can't race the handler's own await chain (collect() reads
    // the request body first) — a fixed `runAllTimersAsync()` call would be
    // an ordering accident that could hang the test under load.
    let persistEntered: () => void;
    const entered = new Promise<void>((resolve) => {
      persistEntered = resolve;
    });
    persistMock.mockImplementationOnce(() => {
      persistEntered();
      return new Promise(() => {}); // never resolves
    });

    const responsePromise = cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );
    await entered;
    await vi.advanceTimersByTimeAsync(PERSIST_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(204);
    const failureCall = warn.mock.calls.find(
      (call) => call[0] === PERSIST_FAILED_LOG_PREFIX,
    );
    expect(failureCall).toBeDefined();
    const logged = JSON.parse(failureCall?.[1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });

  it("logs a forged off-origin report, flags it as not persisted, and never calls the store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forgedReport = {
      "csp-report": {
        "document-uri": "https://attacker.example/",
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
      },
    };

    const response = await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(forgedReport)),
    );

    expect(response.status).toBe(204);
    expect(warn.mock.calls[0][0]).toBe("csp-violation"); // still logged
    const skippedCall = warn.mock.calls.find(
      (call) => call[0] === PERSIST_SKIPPED_LOG_PREFIX,
    );
    expect(skippedCall).toBeDefined();
    expect(JSON.parse(skippedCall?.[1] as string)).toEqual({ skipped: 1 });
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("persists a violation matching the request's own origin under netlify dev, even when it isn't the site origin", async () => {
    // Simulates `netlify dev`: Netlify doesn't inject URL/DEPLOY_PRIME_URL
    // there, and the browser loads the page from localhost, not
    // neonpixels.io, so only the request's own origin (not the env
    // candidates or SITE_ORIGIN) can vouch for this violation. Gated on
    // NETLIFY_DEV so a spoofed Host header can't buy the same trust outside
    // dev (see the next test).
    vi.stubEnv("NETLIFY_DEV", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const localDevReport = {
      "csp-report": {
        "document-uri": "http://localhost:8888/",
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
      },
    };

    const request = new Request("http://localhost:8888/csp-report", {
      method: "POST",
      headers: { "content-type": LEGACY_CONTENT_TYPE },
      body: JSON.stringify(localDevReport),
    });
    await cspReportHandler(request);

    expect(persistMock).toHaveBeenCalledTimes(1);
    const [persisted] = persistMock.mock.calls[0] as [
      { documentUrl: string }[],
    ];
    expect(persisted[0].documentUrl).toBe("http://localhost:8888/");
  });

  it("does not trust a spoofed request origin outside netlify dev", async () => {
    // Guards the fix above: request.url is derived from the client-sent Host
    // header, so outside NETLIFY_DEV it must never be added to the allowed
    // set — otherwise any request could vouch for its own forged origin.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spoofedReport = {
      "csp-report": {
        "document-uri": "https://attacker.example/",
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
      },
    };

    const request = new Request("https://attacker.example/csp-report", {
      method: "POST",
      headers: { "content-type": LEGACY_CONTENT_TYPE },
      body: JSON.stringify(spoofedReport),
    });
    await cspReportHandler(request);

    expect(persistMock).not.toHaveBeenCalled();
  });

  it("persists a violation matching Netlify's injected URL env var", async () => {
    // URL is Netlify's production-domain env var; unset here in tests unless
    // stubbed, so this proves the candidate is read, not just SITE_ORIGIN.
    vi.stubEnv("URL", "https://neonpixels.io");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(LEGACY_REPORT)),
    );

    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("persists a violation matching Netlify's injected DEPLOY_PRIME_URL env var, even when it differs from the site origin and the request's own origin", async () => {
    vi.stubEnv(
      "DEPLOY_PRIME_URL",
      "https://deploy-preview-93--neonpixels.netlify.app",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const previewReport = {
      "csp-report": {
        "document-uri": "https://deploy-preview-93--neonpixels.netlify.app/",
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
      },
    };

    // Posted to the production host, as the deploy-preview Function actually
    // receives it — DEPLOY_PRIME_URL, not the request's own origin, must be
    // what vouches for the preview-domain documentUrl.
    await cspReportHandler(
      postRequest(LEGACY_CONTENT_TYPE, JSON.stringify(previewReport)),
    );

    expect(persistMock).toHaveBeenCalledTimes(1);
    const [persisted] = persistMock.mock.calls[0] as [
      { documentUrl: string }[],
    ];
    expect(persisted[0].documentUrl).toBe(
      "https://deploy-preview-93--neonpixels.netlify.app/",
    );
  });

  it("drops a violation with an empty/unparseable documentUrl rather than treating it as own-origin", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The Reporting API body omits documentURL entirely, so the collector
    // normalizes it to "" — exercises the catch branch in the origin check.
    const reportWithoutDocumentUrl = {
      type: "csp-violation",
      body: { effectiveDirective: "script-src-elem", blockedURL: "inline" },
    };

    await cspReportHandler(
      postRequest(
        REPORTING_API_CONTENT_TYPE,
        JSON.stringify([reportWithoutDocumentUrl]),
      ),
    );

    expect(persistMock).not.toHaveBeenCalled();
  });

  it("persists only the same-origin violations from a mixed batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forgedEntry = {
      type: "csp-violation",
      body: {
        ...REPORTING_API_REPORT.body,
        documentURL: "https://attacker.example/",
      },
    };

    await cspReportHandler(
      postRequest(
        REPORTING_API_CONTENT_TYPE,
        JSON.stringify([REPORTING_API_REPORT, forgedEntry]),
      ),
    );

    expect(persistMock).toHaveBeenCalledTimes(1);
    const [persisted] = persistMock.mock.calls[0] as [
      { documentUrl: string }[],
    ];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].documentUrl).toBe("https://neonpixels.io/");
  });
});
