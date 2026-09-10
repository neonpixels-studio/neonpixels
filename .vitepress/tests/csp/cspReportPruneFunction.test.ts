import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The prune logic itself is a separate, independently-tested unit (see
// cspReportPruner.test.ts); mocking it here keeps this file about the
// adapter's response and logging behavior, not the store walk itself.
const { pruneMock, getCspReportPrunerMock } = vi.hoisted(() => ({
  pruneMock: vi.fn(),
  getCspReportPrunerMock: vi.fn(),
}));
vi.mock("../../../netlify/functions/lib/cspReportPruner", () => ({
  getCspReportPruner: getCspReportPrunerMock,
}));

import cspReportPruneHandler, {
  config,
  HARD_TIMEOUT_MS,
} from "../../../netlify/functions/csp-report-prune";

const PRUNED_LOG_PREFIX = "csp-report-pruned";
const PRUNE_FAILED_LOG_PREFIX = "csp-report-prune-failed";

function scheduledRequest() {
  // Netlify invokes a scheduled Function with a POST carrying `{ next_run }`;
  // the handler ignores the body, but a realistic Request keeps this test
  // honest about the actual call shape.
  return new Request(
    "https://neonpixels.io/.netlify/functions/csp-report-prune",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next_run: "2026-06-16T00:00:00.000Z" }),
    },
  );
}

beforeEach(() => {
  pruneMock
    .mockReset()
    .mockResolvedValue({ deleted: 0, remaining: 0, complete: true });
  getCspReportPrunerMock.mockReset().mockReturnValue({ prune: pruneMock });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("csp-report-prune Netlify scheduled function", () => {
  it("runs on an hourly schedule", () => {
    expect(config.schedule).toBe("@hourly");
  });

  it("prunes the store, replies 200, and logs the outcome", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    pruneMock.mockResolvedValueOnce({
      deleted: 3,
      remaining: 7,
      complete: true,
    });

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith(
      PRUNED_LOG_PREFIX,
      JSON.stringify({ deleted: 3, remaining: 7, complete: true }),
    );
  });

  it("replies 500 and logs a failure marker when the prune run fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(PRUNE_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toBe("blobs unavailable");
  });

  it("replies 500 and logs a failure marker when the store itself is unavailable", async () => {
    // getStore() throws synchronously when the Blobs context is missing (see
    // the equivalent case in cspReportFunction.test.ts) — must be caught the
    // same way here, or a missing context turns every scheduled run into an
    // unhandled exception instead of a logged, retryable-next-hour failure.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getCspReportPrunerMock.mockImplementationOnce(() => {
      throw new Error("missing blobs context");
    });

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(PRUNE_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toBe("missing blobs context");
  });

  it("still replies 200 and logs the incomplete outcome when a run only partially prunes", async () => {
    // The store was too large to fully list/delete inside the time budget —
    // this is not a failure (the next hourly run re-lists and prunes
    // further), so it must not be reported the same way as a thrown error.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    pruneMock.mockResolvedValueOnce({
      deleted: 50,
      remaining: 200,
      complete: false,
    });

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith(
      PRUNED_LOG_PREFIX,
      JSON.stringify({ deleted: 50, remaining: 200, complete: false }),
    );
  });

  it("logs a failure marker and replies 500 when the prune run hangs past the hard timeout", async () => {
    // cspReportPruner's own budgets are cooperative (checked between pages/
    // batches); this proves the handler's own hard timeout is the backstop
    // for a single call that hangs longer than that, e.g. a stalled Blobs
    // request — otherwise Netlify would kill the run at its 30s limit with
    // no csp-report-prune-failed marker ever written.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockImplementationOnce(() => new Promise(() => {}));

    const responsePromise = cspReportPruneHandler(scheduledRequest());
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(PRUNE_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });
});
