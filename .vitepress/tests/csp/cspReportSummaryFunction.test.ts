import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The aggregation logic itself is a separate, independently-tested unit (see
// cspReportSummary.test.ts); mocking it here keeps this file about the
// adapter's response and logging behavior, not the store walk itself.
const { summarizeMock, getCspReportSummaryMock } = vi.hoisted(() => ({
  summarizeMock: vi.fn(),
  getCspReportSummaryMock: vi.fn(),
}));
vi.mock("../../../netlify/functions/lib/cspReportSummary", () => ({
  getCspReportSummary: getCspReportSummaryMock,
}));

import cspReportSummaryHandler, {
  config,
  HARD_TIMEOUT_MS,
} from "../../../netlify/functions/csp-report-summary";

const SUMMARIZED_LOG_PREFIX = "csp-report-summarized";
const SUMMARY_BREAKDOWN_LOG_PREFIX = "csp-report-summary-breakdown";
const SUMMARY_FAILED_LOG_PREFIX = "csp-report-summary-failed";

const EMPTY_SUMMARY = {
  totalListed: 0,
  totalViolations: 0,
  byDirective: [],
  byBlockedUri: [],
  rollout: {
    directive: "script-src",
    count: 0,
    mostRecent: null,
    stopped: true,
  },
  fetchFailures: 0,
  missingEntries: 0,
  invalidEntries: 0,
};

function scheduledRequest() {
  // Netlify invokes a scheduled Function with a POST carrying `{ next_run }`;
  // the handler ignores the body, but a realistic Request keeps this test
  // honest about the actual call shape (mirrors cspReportPruneFunction.test.ts).
  return new Request(
    "https://neonpixels.dev/.netlify/functions/csp-report-summary",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next_run: "2026-06-16T00:00:00.000Z" }),
    },
  );
}

beforeEach(() => {
  summarizeMock.mockReset().mockResolvedValue(EMPTY_SUMMARY);
  getCspReportSummaryMock
    .mockReset()
    .mockReturnValue({ summarize: summarizeMock });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("csp-report-summary Netlify scheduled function", () => {
  it("runs on a daily schedule", () => {
    expect(config.schedule).toBe("@daily");
  });

  it("summarizes the store, replies 200, and logs the decision-relevant fields and breakdowns as separate lines", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = {
      ...EMPTY_SUMMARY,
      totalListed: 2,
      totalViolations: 2,
      byDirective: [{ directive: "style-src", count: 2 }],
      byBlockedUri: [{ blockedUri: "inline", count: 2 }],
    };
    summarizeMock.mockResolvedValueOnce(summary);

    const response = await cspReportSummaryHandler(scheduledRequest());

    expect(response.status).toBe(200);
    // The rollout signal and totals are logged on their own line — the
    // output the whole Function exists to produce — so they're never at
    // risk of truncation from a large byBlockedUri breakdown (see the next
    // assertion and the "caps the byDirective/byBlockedUri breakdowns" test
    // below).
    expect(log).toHaveBeenCalledWith(
      SUMMARIZED_LOG_PREFIX,
      JSON.stringify({
        rollout: summary.rollout,
        totalListed: summary.totalListed,
        totalViolations: summary.totalViolations,
        fetchFailures: summary.fetchFailures,
        missingEntries: summary.missingEntries,
        invalidEntries: summary.invalidEntries,
      }),
    );
    expect(log).toHaveBeenCalledWith(
      SUMMARY_BREAKDOWN_LOG_PREFIX,
      JSON.stringify({
        byDirective: summary.byDirective,
        byBlockedUri: summary.byBlockedUri,
      }),
    );
  });

  it("caps the byDirective/byBlockedUri breakdowns rather than logging an unbounded array", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const byBlockedUri = Array.from({ length: 30 }, (_, index) => ({
      blockedUri: `https://evil.example/${index}.js`,
      count: 1,
    }));
    summarizeMock.mockResolvedValueOnce({
      ...EMPTY_SUMMARY,
      byBlockedUri,
    });

    await cspReportSummaryHandler(scheduledRequest());

    const breakdownCall = log.mock.calls.find(
      (call) => call[0] === SUMMARY_BREAKDOWN_LOG_PREFIX,
    );
    const logged = JSON.parse(breakdownCall?.[1] as string);
    expect(logged.byBlockedUri).toHaveLength(20);
    expect(logged.byBlockedUri).toEqual(byBlockedUri.slice(0, 20));
  });

  it("replies 500 and logs a failure marker when the summary run fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    summarizeMock.mockRejectedValueOnce(new Error("blobs unavailable"));

    const response = await cspReportSummaryHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(SUMMARY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toBe("blobs unavailable");
  });

  it("replies 500 and logs a failure marker when the store itself is unavailable", async () => {
    // getStore() throws synchronously when the Blobs context is missing (see
    // the equivalent case in cspReportFunction.test.ts/cspReportPruneFunction.test.ts)
    // — must be caught the same way here, or a missing context turns every
    // scheduled run into an unhandled exception instead of a logged,
    // retryable-next-day failure.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getCspReportSummaryMock.mockImplementationOnce(() => {
      throw new Error("missing blobs context");
    });

    const response = await cspReportSummaryHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(SUMMARY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toBe("missing blobs context");
  });

  it("logs a failure marker and replies 500 when the summary run hangs past the hard timeout", async () => {
    // cspReportSummary has no cooperative time budget of its own; this
    // proves the handler's own hard timeout is the backstop for a call that
    // hangs longer than that, e.g. a stalled Blobs request — otherwise
    // Netlify would kill the run at its 30s limit with no
    // csp-report-summary-failed marker ever written.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    summarizeMock.mockImplementationOnce(() => new Promise(() => {}));

    const responsePromise = cspReportSummaryHandler(scheduledRequest());
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(SUMMARY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });
});
