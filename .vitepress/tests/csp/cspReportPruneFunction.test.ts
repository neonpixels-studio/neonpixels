import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The prune logic itself is a separate, independently-tested unit (see
// cspReportPruner.test.ts); mocking it here keeps this file about the
// adapter's response and logging behavior, not the store walk itself. The
// failure notifier (see notifyPruneFailure.test.ts) is mocked the same
// way, so these tests only assert that the handler calls it on failure —
// not the GitHub duplicate-guard behavior itself.
const {
  pruneMock,
  getCspReportPrunerMock,
  notifyMock,
  getPruneFailureNotifierMock,
} = vi.hoisted(() => ({
  pruneMock: vi.fn(),
  getCspReportPrunerMock: vi.fn(),
  notifyMock: vi.fn(),
  getPruneFailureNotifierMock: vi.fn(),
}));
vi.mock(
  "../../../netlify/functions/lib/cspReportPruner",
  async (importOriginal) => ({
    // Keeps the real PRUNE_TIME_BUDGET_MS export (needed for the
    // timeout-ordering invariant test below) while still stubbing out
    // getCspReportPruner, the one piece of Blobs-touching behavior this file
    // isn't about.
    ...(await importOriginal<
      typeof import("../../../netlify/functions/lib/cspReportPruner")
    >()),
    getCspReportPruner: getCspReportPrunerMock,
  }),
);
vi.mock("../../../netlify/functions/lib/notifyPruneFailure", () => ({
  getPruneFailureNotifier: getPruneFailureNotifierMock,
}));

import cspReportPruneHandler, {
  config,
  HARD_TIMEOUT_MS,
  NOTIFY_TIMEOUT_MS,
  RUN_DEADLINE_MS,
} from "../../../netlify/functions/csp-report-prune";
import { PRUNE_TIME_BUDGET_MS } from "../../../netlify/functions/lib/cspReportPruner";

const PRUNED_LOG_PREFIX = "csp-report-pruned";
const PRUNE_FAILED_LOG_PREFIX = "csp-report-prune-failed";
const NOTIFY_FAILED_LOG_PREFIX = "csp-report-prune-notify-failed";

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
  notifyMock.mockReset().mockResolvedValue(undefined);
  getPruneFailureNotifierMock
    .mockReset()
    .mockReturnValue({ notify: notifyMock });
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
    // A successful run has nothing to report — the failure notifier (see
    // #123) must only fire on the catch path below.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("replies 500, logs a failure marker, and notifies GitHub when the prune run fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn.mock.calls[0][0]).toBe(PRUNE_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toBe("blobs unavailable");
    expect(notifyMock).toHaveBeenCalledWith("blobs unavailable");
  });

  it("still replies 500 and logs a distinct marker when the failure notifier itself breaks", async () => {
    // A broken notifier (bad token, GitHub API outage) must not mask the
    // real prune failure or crash the handler — see NOTIFY_FAILED_LOG_PREFIX
    // in csp-report-prune.ts.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));
    notifyMock.mockRejectedValueOnce(
      new Error("PRUNE_FAILURE_GITHUB_TOKEN is not set"),
    );

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe(NOTIFY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[1][1] as string);
    expect(logged.message).toBe("PRUNE_FAILURE_GITHUB_TOKEN is not set");
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

  it("gives up on a hanging notifier and still replies 500", async () => {
    // The notifier has its own short budget (NOTIFY_TIMEOUT_MS), separate
    // from the pruner's HARD_TIMEOUT_MS: it only runs after a prune failure,
    // so it must not be able to push the whole run past Netlify's real 30s
    // scheduled-Function limit — see NOTIFY_TIMEOUT_MS in
    // csp-report-prune.ts.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));
    notifyMock.mockImplementationOnce(() => new Promise(() => {}));

    const responsePromise = cspReportPruneHandler(scheduledRequest());
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe(NOTIFY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[1][1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });

  // Netlify scheduled Functions hard-cap execution at 30s; RUN_DEADLINE_MS
  // must leave real headroom under that for cold start and the final
  // in-flight batch rather than assuming the full window.
  const NETLIFY_SCHEDULED_FUNCTION_LIMIT_MS = 30000;
  const COLD_START_HEADROOM_MS = 2000;

  // Pins the budget ordering this handler depends on. Without it, lowering
  // HARD_TIMEOUT_MS (e.g. to make room for NOTIFY_TIMEOUT_MS) could silently
  // drop it below cspReportPruner's own PRUNE_TIME_BUDGET_MS — which would
  // turn every normal partial run (a store too large to finish
  // listing/deleting in one pass, meant to exit gracefully with
  // `complete: false` and retry next hour) into a false failure alarm, since
  // the adapter's hard timeout would win the race before the pruner's own
  // cooperative deadline ever gets to. The second assertion pins
  // RUN_DEADLINE_MS itself against Netlify's real limit — HARD_TIMEOUT_MS +
  // NOTIFY_TIMEOUT_MS always equals RUN_DEADLINE_MS by construction (see
  // csp-report-prune.ts), so asserting that sum against RUN_DEADLINE_MS
  // would be a tautology that can never catch a regression.
  it("keeps the pruner's cooperative budget below the adapter's hard timeout, and the run deadline within Netlify's real limit", () => {
    expect(PRUNE_TIME_BUDGET_MS).toBeLessThan(HARD_TIMEOUT_MS);
    expect(RUN_DEADLINE_MS + COLD_START_HEADROOM_MS).toBeLessThanOrEqual(
      NETLIFY_SCHEDULED_FUNCTION_LIMIT_MS,
    );
  });
});
