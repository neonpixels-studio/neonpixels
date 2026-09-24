import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createCspReportSummary,
  FETCH_BATCH_SIZE,
  SUMMARY_TIME_BUDGET_MS,
  LIST_TIME_BUDGET_MS,
  type BlobSummaryClient,
  type BlobPage,
} from "../../../netlify/functions/lib/cspReportSummary";
import {
  ROLLOUT_DIRECTIVE,
  type StoredCspViolation,
} from "../../../netlify/functions/lib/cspReportStore";

const NOW = new Date("2026-06-15T00:00:00.000Z");

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

// A BlobSummaryClient backed by an in-memory key -> blob map, split across
// the given pages, so tests can assert both aggregation and which keys were
// fetched without touching `@netlify/blobs`.
function fakeClient(
  pages: string[][],
  blobsByKey: Record<string, unknown>,
): BlobSummaryClient & { get: ReturnType<typeof vi.fn> } {
  const getMock = vi.fn(async (key: string) => blobsByKey[key] ?? null);
  return {
    async *list() {
      for (const page of pages) {
        yield {
          blobs: page.map((key) => ({ key }) as BlobPage["blobs"][number]),
        };
      }
    },
    get: getMock,
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

describe("createCspReportSummary", () => {
  it("returns an empty summary for an empty store, and reports the rollout as stopped", async () => {
    // An empty store read with no failures/missing/invalid entries is the
    // designed end state of a successful rollout, not evidence of anything
    // wrong — see the "deliberately NOT gated on the store being non-empty"
    // comment in summarizeRollout for why this must stay true rather than
    // making `stopped` permanently unreachable once retention rolls the
    // last evidence off.
    const client = fakeClient([], {});
    const summary = await createCspReportSummary(client).summarize();

    expect(summary).toEqual({
      complete: true,
      listComplete: true,
      fetchComplete: true,
      totalListed: 0,
      totalFetched: 0,
      totalViolations: 0,
      byDirective: [],
      byBlockedUri: [],
      rollout: {
        directive: ROLLOUT_DIRECTIVE,
        count: 0,
        mostRecent: null,
        stopped: true,
      },
      fetchFailures: 0,
      missingEntries: 0,
      invalidEntries: 0,
    });
  });

  it("aggregates counts by directive, descending, ties broken alphabetically", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "style-src" }),
      b: violation({ effectiveDirective: "style-src" }),
      c: violation({ effectiveDirective: "img-src" }),
      d: violation({ effectiveDirective: "font-src" }),
    };
    const client = fakeClient([["a", "b", "c", "d"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.byDirective).toEqual([
      { directive: "style-src", count: 2 },
      { directive: "font-src", count: 1 },
      { directive: "img-src", count: 1 },
    ]);
  });

  it("aggregates counts by blocked-uri, descending, ties broken alphabetically", async () => {
    const blobs = {
      a: violation({ blockedUri: "https://evil.example/x.js" }),
      b: violation({ blockedUri: "https://evil.example/x.js" }),
      c: violation({ blockedUri: "inline" }),
    };
    const client = fakeClient([["a", "b", "c"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.byBlockedUri).toEqual([
      { blockedUri: "https://evil.example/x.js", count: 2 },
      { blockedUri: "inline", count: 1 },
    ]);
  });

  it("paginates through multiple list pages before aggregating", async () => {
    const blobs = {
      a: violation(),
      b: violation(),
    };
    const client = fakeClient([["a"], ["b"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalListed).toBe(2);
    expect(summary.totalViolations).toBe(2);
  });

  it("reports the rollout as stopped when no script-src-family violations are stored", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "style-src" }),
      b: violation({ effectiveDirective: "img-src" }),
    };
    const client = fakeClient([["a", "b"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.rollout).toEqual({
      directive: ROLLOUT_DIRECTIVE,
      count: 0,
      mostRecent: null,
      stopped: true,
    });
  });

  it("counts script-src-elem and script-src-attr as part of the script-src rollout signal", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "script-src-elem" }),
      b: violation({ effectiveDirective: "script-src-attr" }),
      c: violation({ effectiveDirective: "script-src" }),
      d: violation({ effectiveDirective: "style-src" }),
    };
    const client = fakeClient([["a", "b", "c", "d"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.rollout.count).toBe(3);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("counts an unrecognized script-src-* sub-directive as part of the rollout family", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "script-src-fooxyz" }),
    };
    const client = fakeClient([["a"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    // "script-src-fooxyz" is still evidence of the script-src family under
    // this repo's hyphen-bounded prefix rule, since this policy never
    // declares script-src sub-directives separately (see isRolloutDirective).
    expect(summary.rollout.count).toBe(1);
  });

  it("does not count a directive that merely contains the word script-src as part of the rollout", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "my-script-src-elem" }),
    };
    const client = fakeClient([["a"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    // Proves the rule is a hyphen-bounded prefix match, not a bare substring
    // match — the case the previous version of this test claimed to cover
    // but never actually exercised.
    expect(summary.rollout.count).toBe(0);
  });

  it("surfaces the most recent script-src violation when the rollout has not stopped", async () => {
    const blobs = {
      old: violation({
        effectiveDirective: "script-src-elem",
        receivedAt: "2026-06-01T00:00:00.000Z",
        blockedUri: "https://old.example/x.js",
      }),
      recent: violation({
        effectiveDirective: "script-src-elem",
        receivedAt: "2026-06-15T00:00:00.000Z",
        blockedUri: "https://recent.example/x.js",
      }),
    };
    const client = fakeClient([["old", "recent"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.rollout.mostRecent?.blockedUri).toBe(
      "https://recent.example/x.js",
    );
  });

  it("skips a fetched entry that doesn't match the StoredCspViolation shape, without crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blobs = {
      good: violation(),
      bad: { unrelated: "shape" },
    };
    const client = fakeClient([["good", "bad"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalListed).toBe(2);
    expect(summary.totalViolations).toBe(1);
    expect(summary.invalidEntries).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-invalid-entry",
      JSON.stringify({ key: "bad" }),
    );
  });

  it("counts a get() failure without discarding the rest of the summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient([["good", "broken"]], { good: violation() });
    client.get.mockImplementation(async (key: string) => {
      if (key === "broken") {
        throw new Error("blobs unavailable");
      }
      return violation();
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalListed).toBe(2);
    expect(summary.totalViolations).toBe(1);
    expect(summary.fetchFailures).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-fetch-failed",
      JSON.stringify({ key: "broken", message: "blobs unavailable" }),
    );
  });

  it("counts a key evicted between list() and get() as missing, not invalid, and does not log it", async () => {
    // Netlify Blobs resolves get() to null for a key that no longer exists
    // (it does not throw) — realistic here because the hourly pruner can
    // delete a key while a summary run is still walking the store.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient([["good", "gone"]], { good: violation() });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalListed).toBe(2);
    expect(summary.totalViolations).toBe(1);
    expect(summary.missingEntries).toBe(1);
    expect(summary.invalidEntries).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports the rollout as not stopped when a key evicted mid-walk could be hiding a script-src violation", async () => {
    // missingEntries is folded into the fail-closed gate alongside
    // fetchFailures/invalidEntries: the pruner's count-cap pass evicts fresh
    // keys oldest-first whenever the store is over CSP_REPORT_MAX_BLOBS, not
    // only retention-aged ones, so a key missing here can genuinely have
    // been a recent violation this run lost the race to read.
    const client = fakeClient([["style", "gone"]], {
      style: violation({ effectiveDirective: "style-src" }),
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.missingEntries).toBe(1);
    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("rejects a fetched entry missing a required StoredCspViolation field as invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sample: _sample, ...missingSample } = violation();
    const client = fakeClient([["bad"]], { bad: missingSample });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalViolations).toBe(0);
    expect(summary.invalidEntries).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-invalid-entry",
      JSON.stringify({ key: "bad" }),
    );
  });

  it("rejects a receivedAt that isn't a real ISO timestamp as invalid", async () => {
    // mostRecentOf relies on lexicographic ISO ordering (see that function);
    // a non-ISO string would sort arbitrarily against real timestamps
    // instead of failing the shape check outright.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient([["bad"]], {
      bad: violation({ receivedAt: "not-a-timestamp" }),
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalViolations).toBe(0);
    expect(summary.invalidEntries).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-invalid-entry",
      JSON.stringify({ key: "bad" }),
    );
  });

  it("fetches in batches of exactly FETCH_BATCH_SIZE rather than sequentially or all at once", async () => {
    const keys = Array.from(
      { length: FETCH_BATCH_SIZE + 10 },
      (_, index) => `key-${index}`,
    );
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    let maxConcurrent = 0;
    let inFlight = 0;
    const client = fakeClient([keys], blobs);
    client.get.mockImplementation(async (key: string) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return blobs[key];
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.totalViolations).toBe(keys.length);
    expect(client.get).toHaveBeenCalledTimes(keys.length);
    // Exact, not <=: a regression to sequential fetching would peak at 1
    // (still <= FETCH_BATCH_SIZE), and raising FETCH_BATCH_SIZE to cover the
    // whole key set would make this pass for the wrong reason too, since a
    // looser assertion would compare the constant against itself either way.
    expect(maxConcurrent).toBe(FETCH_BATCH_SIZE);
  });

  it("reports the rollout as not stopped when a fetch failure could be hiding a script-src violation", async () => {
    // Only non-script-src violations parsed successfully, but a key failed
    // to fetch entirely — the summary can't rule out that key having been
    // script-src, so it must fail closed rather than report a clean rollout
    // on incomplete evidence.
    const client = fakeClient([["style", "broken"]], {
      style: violation({ effectiveDirective: "style-src" }),
    });
    client.get.mockImplementation(async (key: string) => {
      if (key === "broken") {
        throw new Error("blobs unavailable");
      }
      return violation({ effectiveDirective: "style-src" });
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("reports the rollout as not stopped when an invalid entry could be hiding a script-src violation", async () => {
    const client = fakeClient([["style", "bad"]], {
      style: violation({ effectiveDirective: "style-src" }),
      bad: { unrelated: "shape" },
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("returns a partial summary — real counts, not zeroed out — when fetchAll's own time budget runs out mid-walk", async () => {
    // One extra batch beyond FETCH_BATCH_SIZE so the deadline check between
    // batches has a second batch to correctly refuse.
    const keys = Array.from(
      { length: FETCH_BATCH_SIZE + 5 },
      (_, index) => `key-${index}`,
    );
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    const client = fakeClient([keys], blobs);
    let getCalls = 0;
    client.get.mockImplementation(async (key: string) => {
      getCalls += 1;
      // Once the first batch finishes, the budget is spent — the second,
      // shorter batch after it must never be attempted.
      if (getCalls === FETCH_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + SUMMARY_TIME_BUDGET_MS + 1));
      }
      return blobs[key];
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.complete).toBe(false);
    // totalListed reflects every key list() returned, regardless of whether
    // fetchAll got to it — totalFetched/totalViolations are the real,
    // non-zero counts of what was actually fetched before the deadline.
    expect(summary.totalListed).toBe(keys.length);
    expect(summary.totalFetched).toBe(FETCH_BATCH_SIZE);
    expect(summary.totalViolations).toBe(FETCH_BATCH_SIZE);
    expect(client.get).toHaveBeenCalledTimes(FETCH_BATCH_SIZE);
  });

  it("still returns a complete summary when the run finishes within the time budget", async () => {
    const keys = Array.from(
      { length: FETCH_BATCH_SIZE + 5 },
      (_, index) => `key-${index}`,
    );
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    const client = fakeClient([keys], blobs);

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.complete).toBe(true);
    expect(summary.totalListed).toBe(keys.length);
    expect(summary.totalFetched).toBe(keys.length);
    expect(summary.totalViolations).toBe(keys.length);
    expect(client.get).toHaveBeenCalledTimes(keys.length);
  });

  it("reports listComplete: true when the deadline passes on the store's true last page (clock advances before that page is yielded)", async () => {
    const keys = ["key-a", "key-b"];
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      async *list() {
        vi.setSystemTime(new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1));
        yield { blobs: keys.map((key) => ({ key })) };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(true);
    expect(summary.complete).toBe(true);
    expect(summary.totalListed).toBe(keys.length);
  });

  it("reports listComplete: true but fetchComplete: false when only the store's one page stalls past the whole run budget", async () => {
    const keys = Array.from(
      { length: FETCH_BATCH_SIZE + 5 },
      (_, index) => `key-${index}`,
    );
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      async *list() {
        // The one and only page stalls past the whole run's budget.
        vi.setSystemTime(new Date(NOW.getTime() + SUMMARY_TIME_BUDGET_MS + 1));
        yield { blobs: keys.map((key) => ({ key })) };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(true);
    expect(summary.fetchComplete).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.totalListed).toBe(keys.length);
    expect(summary.totalFetched).toBe(0);
    expect(summary.totalViolations).toBe(0);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("stops listing after one probe page past its own time budget, discarding that page rather than absorbing it", async () => {
    // Once the deadline trips after page 1, listAllKeys pulls exactly one
    // further page as a probe. Finding it real (not `done`) proves more
    // data exists beyond the deadline, so that probe page's keys are
    // discarded rather than merged in — keeping `complete: false` accurate
    // (real data was left out) without ever absorbing more than one extra
    // page past the deadline. Neither the probe page nor anything after it
    // reaches fetchAll.
    const page1Keys = ["key-a", "key-b"];
    const probePageKey = "key-peeked";
    const neverReachedKey = "key-never-reached";
    const blobs = Object.fromEntries(
      [...page1Keys, probePageKey, neverReachedKey].map((key) => [
        key,
        violation(),
      ]),
    );
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      async *list() {
        vi.setSystemTime(new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1));
        yield { blobs: page1Keys.map((key) => ({ key })) };
        yield { blobs: [{ key: probePageKey }] };
        yield { blobs: [{ key: neverReachedKey }] };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.complete).toBe(false);
    expect(summary.listComplete).toBe(false);
    expect(summary.fetchComplete).toBe(true);
    expect(summary.totalListed).toBe(page1Keys.length);
    expect(summary.totalFetched).toBe(page1Keys.length);
    expect(summary.totalViolations).toBe(page1Keys.length);
    expect(client.get).not.toHaveBeenCalledWith(probePageKey);
    expect(client.get).not.toHaveBeenCalledWith(neverReachedKey);
  });

  it("returns a partial, fail-closed result instead of throwing when the list pass itself rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async () => violation()),
      // Not a generator (require-yield would flag one with no yield): a
      // plain AsyncIterable whose first next() rejects, simulating a
      // list() call that fails outright rather than ever yielding a page.
      list(): AsyncIterable<BlobPage> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(new Error("blobs list unavailable")),
            };
          },
        };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.totalListed).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-list-failed",
      JSON.stringify({ message: "blobs list unavailable" }),
    );
  });

  it("retains already-listed keys and returns partial when a later page rejects mid-walk", async () => {
    // Proves pullPage's "count it, don't crash" contract for a rejection
    // that lands before the deadline is even a factor: keys already
    // collected must survive a later page's rejection, not just produce the
    // same empty result a plain throw-and-catch would.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page1Keys = ["key-a", "key-b"];
    const blobs = Object.fromEntries(
      page1Keys.map((key) => [key, violation()]),
    );
    let callCount = 0;
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      list(): AsyncIterable<BlobPage> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                callCount += 1;
                if (callCount === 1) {
                  return Promise.resolve({
                    done: false,
                    value: { blobs: page1Keys.map((key) => ({ key })) },
                  });
                }
                return Promise.reject(new Error("blobs list unavailable"));
              },
            };
          },
        };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.totalListed).toBe(page1Keys.length);
    expect(client.get).toHaveBeenCalledTimes(page1Keys.length);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-list-failed",
      JSON.stringify({ message: "blobs list unavailable" }),
    );
  });

  it("returns a partial, fail-closed result when the rejection lands in the post-deadline probe pull", async () => {
    // Same "count it, don't crash" contract as the test above, but for a
    // rejection in the one-page probe pull past the deadline specifically
    // (the other call site pullPage guards), not the ordinary pre-deadline
    // walk.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page1Keys = ["key-a", "key-b"];
    const blobs = Object.fromEntries(
      page1Keys.map((key) => [key, violation()]),
    );
    let callCount = 0;
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      list(): AsyncIterable<BlobPage> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                callCount += 1;
                if (callCount === 1) {
                  vi.setSystemTime(
                    new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1),
                  );
                  return Promise.resolve({
                    done: false,
                    value: { blobs: page1Keys.map((key) => ({ key })) },
                  });
                }
                return Promise.reject(new Error("blobs list unavailable"));
              },
            };
          },
        };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.totalListed).toBe(page1Keys.length);
    expect(client.get).toHaveBeenCalledTimes(page1Keys.length);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-summary-list-failed",
      JSON.stringify({ message: "blobs list unavailable" }),
    );
  });

  it("reports the rollout as not stopped when the fetch pass is cut short, even if every fetched entry was clean", async () => {
    // Proves the fail-closed gate treats an unattempted key (never fetched
    // at all, because the budget ran out) the same as a failed or missing
    // one — none of the keys that *were* fetched are script-src, so without
    // folding `complete` into the gate this would wrongly read as stopped.
    const keys = Array.from(
      { length: FETCH_BATCH_SIZE + 1 },
      (_, index) => `key-${index}`,
    );
    const blobs = Object.fromEntries(
      keys.map((key) => [key, violation({ effectiveDirective: "style-src" })]),
    );
    const client = fakeClient([keys], blobs);
    let getCalls = 0;
    client.get.mockImplementation(async (key: string) => {
      getCalls += 1;
      if (getCalls === FETCH_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + SUMMARY_TIME_BUDGET_MS + 1));
      }
      return blobs[key];
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.complete).toBe(false);
    expect(summary.fetchComplete).toBe(false);
    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("reports the rollout as not stopped when the list pass is cut short, even though every fetched entry was clean and fetchAll itself finished", async () => {
    // The sibling of the test above, for the other half of `complete`
    // (listComplete rather than fetchComplete): totalFetched === totalListed
    // here, so this is exactly the case where the summary could look fully
    // read at a glance — without folding `complete` into the gate, a
    // truncated list pass hiding an unlisted script-src violation would
    // wrongly report stopped: true.
    const page1Keys = ["key-a", "key-b"];
    const probePageKey = "key-peeked";
    const neverReachedKey = "key-never-reached";
    const blobs = Object.fromEntries(
      [...page1Keys, probePageKey, neverReachedKey].map((key) => [
        key,
        violation({ effectiveDirective: "style-src" }),
      ]),
    );
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => blobs[key]),
      async *list() {
        vi.setSystemTime(new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1));
        yield { blobs: page1Keys.map((key) => ({ key })) };
        yield { blobs: [{ key: probePageKey }] };
        yield { blobs: [{ key: neverReachedKey }] };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.complete).toBe(false);
    expect(summary.listComplete).toBe(false);
    expect(summary.fetchComplete).toBe(true);
    expect(summary.totalFetched).toBe(summary.totalListed);
    expect(summary.totalListed).toBe(page1Keys.length);
    expect(client.get).not.toHaveBeenCalledWith(probePageKey);
    expect(client.get).not.toHaveBeenCalledWith(neverReachedKey);
    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(false);
  });

  it("prioritizes the newest keys when fetchAll's own budget forces a truncated read", async () => {
    // Keys are sortable by a leading timestamp (mirrors the real
    // `<sanitized receivedAt>-<tag>-<uuid>.json` shape from
    // cspReportStore.ts) and are deliberately handed to the fake client
    // oldest-first, the order list() is not documented to return (the
    // pruner sorts its own unsortedKeys rather than trusting it) — so this
    // only passes if the run sorts newest-first before truncating, not
    // whatever order happened to arrive from list(). The rollout signal
    // this module exists to produce is about *recent* activity, so a
    // truncated run must drop the oldest evidence, not the newest.
    const keyCount = FETCH_BATCH_SIZE + 5;
    const keys = Array.from({ length: keyCount }, (_, index) => {
      const timestamp = new Date(NOW.getTime() - (keyCount - index) * 1000)
        .toISOString()
        .replace(/[:.]/g, "-");
      return `${timestamp}-key-${index}`;
    });
    const newestKeys = keys.slice(keys.length - FETCH_BATCH_SIZE);
    const oldestKeys = keys.slice(0, keys.length - FETCH_BATCH_SIZE);
    const blobs = Object.fromEntries(keys.map((key) => [key, violation()]));
    const client = fakeClient([keys], blobs);
    let getCalls = 0;
    client.get.mockImplementation(async (key: string) => {
      getCalls += 1;
      if (getCalls === FETCH_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + SUMMARY_TIME_BUDGET_MS + 1));
      }
      return blobs[key];
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.fetchComplete).toBe(false);
    expect(summary.totalFetched).toBe(FETCH_BATCH_SIZE);
    for (const key of newestKeys) {
      expect(client.get).toHaveBeenCalledWith(key, expect.anything());
    }
    for (const key of oldestKeys) {
      expect(client.get).not.toHaveBeenCalledWith(key, expect.anything());
    }
  });

  it("reports both listComplete: false and fetchComplete: false when an oversized store trips both budgets in the same run", async () => {
    // The realistic shape for a store consistently too large to finish in
    // one run: the list pass gets cut short by LIST_TIME_BUDGET_MS, and the
    // keys already committed by then are still enough on their own to also
    // trip fetchAll's SUMMARY_TIME_BUDGET_MS before every one of them is
    // attempted — the fullest csp-report-summary-incomplete payload the
    // adapter can log.
    const page1Keys = Array.from(
      { length: FETCH_BATCH_SIZE },
      (_, index) => `page1-key-${index}`,
    );
    const page2Keys = ["page2-key-0", "page2-key-1", "page2-key-2"];
    const probePageKey = "key-peeked";
    const committedKeys = [...page1Keys, ...page2Keys];
    const blobs = Object.fromEntries(
      [...committedKeys, probePageKey].map((key) => [key, violation()]),
    );
    let getCalls = 0;
    const client: BlobSummaryClient & { get: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async (key: string) => {
        getCalls += 1;
        if (getCalls === FETCH_BATCH_SIZE) {
          vi.setSystemTime(
            new Date(NOW.getTime() + SUMMARY_TIME_BUDGET_MS + 1),
          );
        }
        return blobs[key];
      }),
      async *list() {
        yield { blobs: page1Keys.map((key) => ({ key })) };
        vi.setSystemTime(new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1));
        yield { blobs: page2Keys.map((key) => ({ key })) };
        yield { blobs: [{ key: probePageKey }] };
      },
    };

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.listComplete).toBe(false);
    expect(summary.fetchComplete).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.totalListed).toBe(committedKeys.length);
    expect(summary.totalFetched).toBe(FETCH_BATCH_SIZE);
    expect(client.get).not.toHaveBeenCalledWith(
      probePageKey,
      expect.anything(),
    );
  });
});
