import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createCspReportSummary,
  FETCH_BATCH_SIZE,
  LIST_TIME_BUDGET_MS,
  SUMMARY_TIME_BUDGET_MS,
  type BlobSummaryClient,
  type BlobPage,
} from "../../../netlify/functions/lib/cspReportSummary";
import {
  DEFAULT_MAX_BLOBS,
  DELETE_BATCH_SIZE,
} from "../../../netlify/functions/lib/cspReportPruner";
import { type StoredCspViolation } from "../../../netlify/functions/lib/cspReportStore";

// Regression coverage for #151: at FETCH_BATCH_SIZE=25 and a fully-loaded
// store (the default CSP_REPORT_MAX_BLOBS, 5000), fetchAll needed 200
// sequential round trips, and only ever gets a share of SUMMARY_TIME_BUDGET_MS
// left over once listAllKeys has spent its own half. This file doesn't hit
// real Netlify Blobs (this repo has no linked site to measure against), so
// it simulates plausible per-request latency with real `setTimeout` delays
// under fake timers instead of asserting on abstract math alone: `get()`
// returns a promise that resolves after `perRequestLatencyMs`, so the
// simulation exercises fetchAll's *actual* concurrency (or lack of it)
// rather than assuming batches are concurrent — a regression to sequential
// fetching would make every case below take FETCH_BATCH_SIZE times longer
// and fail the budget assertions, and is separately caught directly by the
// `maxInFlight` assertion.

const NOW = new Date("2026-06-15T00:00:00.000Z");

// A pessimistic, but plausible, per-batch tail latency for a remote
// key/value store under normal network variance (not a pathological
// outage) — see the FETCH_BATCH_SIZE comment in cspReportSummary.ts. Chosen
// to leave real headroom (see minimumHeadroomMs below), so this is the
// latency the "clears with room to spare" claim in that comment is measured
// against.
const PESSIMISTIC_LATENCY_MS = 150;

function violation(
  overrides: Partial<StoredCspViolation> = {},
): StoredCspViolation {
  return {
    documentUrl: "https://neonpixels.dev/",
    effectiveDirective: "style-src",
    blockedUri: "inline",
    disposition: "report",
    sourceFile: "",
    lineNumber: null,
    columnNumber: null,
    sample: "",
    receivedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

type LatencyClient = {
  client: BlobSummaryClient;
  // Peak number of concurrent, unresolved get() calls seen so far — proves
  // fetchAll actually fans a batch out concurrently instead of merely
  // taking the same wall-clock path a sequential implementation would.
  maxInFlight(): number;
};

// list() always models the worst case fetchAll's own comments describe: a
// slow list() walk that spends its full LIST_TIME_BUDGET_MS before fetchAll
// runs at all, leaving fetchAll only the remainder of SUMMARY_TIME_BUDGET_MS
// rather than the full budget. get() resolves after a real (fake-timer)
// delay per call rather than advancing the clock by hand, so a batch's
// concurrency is measured, not assumed. `shouldFail` lets a subset of keys
// reject instead of resolve, so the same latency simulation can also prove a
// failure doesn't sink its whole batch at the new, wider fan-out.
function latencyClient(
  keyCount: number,
  perRequestLatencyMs: number,
  shouldFail: (_key: string) => boolean = () => false,
): LatencyClient {
  const keys = Array.from({ length: keyCount }, (_, index) =>
    String(index).padStart(6, "0"),
  );
  const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    client: {
      async *list() {
        vi.setSystemTime(new Date(Date.now() + LIST_TIME_BUDGET_MS + 1));
        yield { blobs: keys.map((key) => ({ key })) } as BlobPage;
      },
      get(key: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            inFlight -= 1;
            if (shouldFail(key)) {
              reject(new Error(`simulated failure for ${key}`));
              return;
            }
            resolve(blobs[key] ?? null);
          }, perRequestLatencyMs);
        });
      },
    },
    maxInFlight: () => maxInFlight,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchAll throughput at a fully-loaded CSP_REPORT_MAX_BLOBS store", () => {
  it.each([10, 25, 50, 100, PESSIMISTIC_LATENCY_MS, 200])(
    "completes a %ims/batch fully-loaded store within budget even when list() has already spent its share",
    async (perRequestLatencyMs) => {
      const { client, maxInFlight } = latencyClient(
        DEFAULT_MAX_BLOBS,
        perRequestLatencyMs,
      );

      const summaryPromise = createCspReportSummary(client).summarize();
      await vi.runAllTimersAsync();
      const summary = await summaryPromise;

      expect(summary.fetchComplete).toBe(true);
      expect(summary.totalFetched).toBe(DEFAULT_MAX_BLOBS);
      expect(summary.totalViolations).toBe(DEFAULT_MAX_BLOBS);
      // DEFAULT_MAX_BLOBS is well over FETCH_BATCH_SIZE, so fetchAll's
      // first batch alone is full-size — a regression to sequential (or
      // partially concurrent) fetching would peak below FETCH_BATCH_SIZE
      // here even though the outcome assertions above might still happen
      // to pass at a lenient latency.
      expect(DEFAULT_MAX_BLOBS).toBeGreaterThanOrEqual(FETCH_BATCH_SIZE);
      expect(maxInFlight()).toBe(FETCH_BATCH_SIZE);
    },
  );

  it("still counts a fetch failure without dropping the rest of its batch at the wider fan-out", async () => {
    // fetchOne already isolates a rejected get() per key regardless of
    // batch size (see cspReportSummary.test.ts's own failure coverage), but
    // that guarantee is what makes it safe to widen FETCH_BATCH_SIZE at all
    // — a failure that took down its whole Promise.all batch would turn a
    // single flaky key into losing up to FETCH_BATCH_SIZE reads instead of
    // one. Every 37th key fails here (an arbitrary, non-uniform spacing so
    // failures land in different batches, not always the same slot).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingKeyEvery = 37;
    const shouldFail = (key: string): boolean =>
      Number(key) % failingKeyEvery === 0;
    const { client } = latencyClient(
      DEFAULT_MAX_BLOBS,
      PESSIMISTIC_LATENCY_MS,
      shouldFail,
    );
    const expectedFailures = Math.ceil(DEFAULT_MAX_BLOBS / failingKeyEvery);

    const summaryPromise = createCspReportSummary(client).summarize();
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary.fetchComplete).toBe(true);
    expect(summary.totalFetched).toBe(DEFAULT_MAX_BLOBS);
    expect(summary.fetchFailures).toBe(expectedFailures);
    expect(summary.totalViolations).toBe(DEFAULT_MAX_BLOBS - expectedFailures);
    // The wider fan-out raises how often a get() fails (more concurrent
    // requests against Blobs), so it's worth pinning here specifically:
    // summarizeRollout's existing fail-closed gate (see that function in
    // cspReportSummary.ts) must still refuse to report `stopped: true` on
    // this run, since any of the failed keys could have been a hidden
    // script-src violation.
    expect(summary.rollout.stopped).toBe(false);
  });

  it("still degrades to a real, partial summary rather than crashing when latency is pathological", async () => {
    // Not a claim that any batch size makes fetchAll immune to a genuine
    // outage-level latency — this pins the fail-closed contract (partial,
    // non-throwing, fetchComplete: false) that summarizeRollout's
    // fail-closed gate depends on, for a latency far past what
    // FETCH_BATCH_SIZE is tuned for.
    // Derived from the real budget (rather than a standalone literal) so
    // this keeps forcing a mid-walk cutoff even if the budget constants
    // change later: comfortably more than one batch's worth of the
    // guaranteed worst-case fetch budget, so at least one batch completes
    // and at least one more is left unattempted.
    const pathologicalLatencyMs = Math.floor(
      (SUMMARY_TIME_BUDGET_MS - LIST_TIME_BUDGET_MS) / 2,
    );
    const { client } = latencyClient(DEFAULT_MAX_BLOBS, pathologicalLatencyMs);

    const summaryPromise = createCspReportSummary(client).summarize();
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary.fetchComplete).toBe(false);
    expect(summary.totalFetched).toBeGreaterThan(0);
    expect(summary.totalFetched).toBeLessThan(DEFAULT_MAX_BLOBS);
    expect(summary.rollout.stopped).toBe(false);
  });

  // Documents the exact ceiling this fix depends on, so a future change to
  // either constant fails loudly here instead of silently reopening #151:
  // round trips for a fully-loaded store times a pessimistic per-batch tail
  // latency must fit inside fetchAll's guaranteed worst-case share of the
  // budget with real headroom to spare.
  it("keeps round trips for a fully-loaded store within the guaranteed worst-case fetch budget, with headroom, at a pessimistic per-batch latency", () => {
    const guaranteedWorstCaseFetchBudgetMs =
      SUMMARY_TIME_BUDGET_MS - LIST_TIME_BUDGET_MS;
    const roundTrips = Math.ceil(DEFAULT_MAX_BLOBS / FETCH_BATCH_SIZE);
    const minimumHeadroomMs = 2000;

    expect(
      roundTrips * PESSIMISTIC_LATENCY_MS + minimumHeadroomMs,
    ).toBeLessThanOrEqual(guaranteedWorstCaseFetchBudgetMs);
  });

  // Pins the other half of the FETCH_BATCH_SIZE comment's claim: the wider
  // fan-out this fix introduces stays a bounded multiple of DELETE_BATCH_SIZE
  // (cspReportPruner.ts's own accepted concurrency for a delete pass against
  // this same store), rather than the two silently drifting apart. Not a
  // claim that FETCH_BATCH_SIZE + DELETE_BATCH_SIZE concurrently is safe if
  // the hourly prune and the daily summary ever overlap in-flight — that's a
  // separate, cross-Function concurrency budget this test doesn't cover.
  it("keeps FETCH_BATCH_SIZE within 2x DELETE_BATCH_SIZE, cspReportPruner.ts's own accepted concurrency for this store", () => {
    expect(FETCH_BATCH_SIZE).toBeLessThanOrEqual(2 * DELETE_BATCH_SIZE);
  });
});
