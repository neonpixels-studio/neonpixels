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
  resolveMock,
  getPruneFailureResolverMock,
} = vi.hoisted(() => ({
  pruneMock: vi.fn(),
  getCspReportPrunerMock: vi.fn(),
  notifyMock: vi.fn(),
  getPruneFailureNotifierMock: vi.fn(),
  resolveMock: vi.fn(),
  getPruneFailureResolverMock: vi.fn(),
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
  getPruneFailureResolver: getPruneFailureResolverMock,
}));

import cspReportPruneHandler, {
  config,
  HARD_TIMEOUT_MS,
} from "../../../netlify/functions/csp-report-prune";
import {
  NOTIFY_TIMEOUT_MS,
  RUN_DEADLINE_MS,
  remainingNotifyBudgetMs,
} from "../../../netlify/functions/lib/notifyBudget";
import { PRUNE_TIME_BUDGET_MS } from "../../../netlify/functions/lib/cspReportPruner";

const PRUNED_LOG_PREFIX = "csp-report-pruned";
const PRUNE_FAILED_LOG_PREFIX = "csp-report-prune-failed";
const NOTIFY_FAILED_LOG_PREFIX = "csp-report-prune-notify-failed";
const RESOLVE_FAILED_LOG_PREFIX = "csp-report-prune-resolve-failed";

function scheduledRequest() {
  // Netlify invokes a scheduled Function with a POST carrying `{ next_run }`;
  // the handler ignores the body, but a realistic Request keeps this test
  // honest about the actual call shape.
  return new Request(
    "https://neonpixels.dev/.netlify/functions/csp-report-prune",
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
  resolveMock.mockReset().mockResolvedValue(undefined);
  getPruneFailureResolverMock
    .mockReset()
    .mockReturnValue({ resolve: resolveMock });
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
    // ...and a successful run is what closes a previously-tracked issue
    // (see #163).
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it("does not try to close a tracked issue when the prune run fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));

    await cspReportPruneHandler(scheduledRequest());

    expect(getPruneFailureResolverMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("still replies 200 and logs a distinct marker when closing the tracked issue breaks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    resolveMock.mockRejectedValueOnce(new Error("github down"));

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      RESOLVE_FAILED_LOG_PREFIX,
      JSON.stringify({ message: "github down" }),
    );
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

  it("cuts a hanging notifier off at the remaining budget after the prune run hangs", async () => {
    // After a hang to HARD_TIMEOUT_MS the notifier only gets what is left of
    // RUN_DEADLINE_MS (minus response headroom), not the full
    // NOTIFY_TIMEOUT_MS. Fails if the handler ignores the shared budget and
    // passes a fixed timeout.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockImplementationOnce(() => new Promise(() => {}));
    notifyMock.mockImplementationOnce(() => new Promise(() => {}));
    const afterHangBudgetMs = remainingNotifyBudgetMs(HARD_TIMEOUT_MS);
    expect(afterHangBudgetMs).toBeLessThan(NOTIFY_TIMEOUT_MS);
    let settled = false;

    const responsePromise = cspReportPruneHandler(scheduledRequest()).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(afterHangBudgetMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe(NOTIFY_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[1][1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });

  it("gives a hanging notifier its full NOTIFY_TIMEOUT_MS after a fast failure", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockRejectedValueOnce(new Error("blobs unavailable"));
    notifyMock.mockImplementationOnce(() => new Promise(() => {}));
    let settled = false;

    const responsePromise = cspReportPruneHandler(scheduledRequest()).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(warn.mock.calls[1][0]).toBe(NOTIFY_FAILED_LOG_PREFIX);
  });

  it("skips the notifier and logs when no time is left after the failure", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneMock.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + RUN_DEADLINE_MS);
      return Promise.reject(new Error("blocked event loop"));
    });

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(500);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(warn.mock.calls[1][0]).toBe(NOTIFY_FAILED_LOG_PREFIX);
    expect(JSON.parse(warn.mock.calls[1][1] as string).message).toBe(
      "no time left to notify",
    );
  });

  it("gives up on a hanging resolver and still replies 200", async () => {
    // Gets the full NOTIFY_TIMEOUT_MS here because the run is fresh; the
    // shrinking case after a slow prune is covered below.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    resolveMock.mockImplementationOnce(() => new Promise(() => {}));

    const responsePromise = cspReportPruneHandler(scheduledRequest());
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(warn.mock.calls[0][0]).toBe(RESOLVE_FAILED_LOG_PREFIX);
    const logged = JSON.parse(warn.mock.calls[0][1] as string);
    expect(logged.message).toMatch(/exceeded/);
  });

  it("cuts a hanging resolver off at the remaining budget after a slow successful prune", async () => {
    // Fails if the resolver ignores the shared budget: a prune finishing just
    // under HARD_TIMEOUT_MS must not hand the resolver a full
    // NOTIFY_TIMEOUT_MS that runs into the response headroom.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const slowPruneMs = HARD_TIMEOUT_MS - 1;
    pruneMock.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ deleted: 0, remaining: 0, complete: true }),
            slowPruneMs,
          ),
        ),
    );
    resolveMock.mockImplementationOnce(() => new Promise(() => {}));
    const resolverBudgetMs = remainingNotifyBudgetMs(slowPruneMs);
    expect(resolverBudgetMs).toBeLessThan(NOTIFY_TIMEOUT_MS);
    let settled = false;

    const responsePromise = cspReportPruneHandler(scheduledRequest()).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.advanceTimersByTimeAsync(slowPruneMs);
    expect(resolveMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(resolverBudgetMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(warn.mock.calls[0][0]).toBe(RESOLVE_FAILED_LOG_PREFIX);
  });

  it("skips the resolver and logs when no time is left after the prune run", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    pruneMock.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + RUN_DEADLINE_MS);
      return Promise.resolve({ deleted: 0, remaining: 0, complete: true });
    });

    const response = await cspReportPruneHandler(scheduledRequest());

    expect(response.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toBe(RESOLVE_FAILED_LOG_PREFIX);
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
