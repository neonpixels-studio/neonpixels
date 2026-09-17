import { describe, it, expect, vi, afterEach } from "vitest";

import {
  createCspReportSummary,
  ROLLOUT_DIRECTIVE,
  FETCH_BATCH_SIZE,
  type BlobSummaryClient,
  type BlobPage,
} from "../../../netlify/functions/lib/cspReportSummary";
import type { StoredCspViolation } from "../../../netlify/functions/lib/cspReportStore";

function violation(
  overrides: Partial<StoredCspViolation> = {},
): StoredCspViolation {
  return {
    documentUrl: "https://neonpixels.io/",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCspReportSummary", () => {
  it("returns an empty summary for an empty store, but does not report the rollout as stopped", async () => {
    // An empty store is exactly what a silently broken collector (a 500
    // from /csp-report, a mistyped report-uri, an over-eager prune) would
    // also produce — indistinguishable from a genuinely finished rollout
    // without positive evidence the store has anything in it at all, so
    // `stopped` requires totalListed > 0 (see summarizeRollout).
    const client = fakeClient([], {});
    const summary = await createCspReportSummary(client).summarize();

    expect(summary).toEqual({
      totalListed: 0,
      totalViolations: 0,
      byDirective: [],
      byBlockedUri: [],
      rollout: {
        directive: ROLLOUT_DIRECTIVE,
        count: 0,
        mostRecent: null,
        stopped: false,
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

  it("still reports the rollout as stopped when the only unread evidence is a missing (pruned) key, not a fetch failure or invalid entry", async () => {
    // missingEntries is deliberately excluded from the fail-closed gate in
    // summarizeRollout — a key the pruner already deleted has aged out of
    // the retention window, not evidence of a hidden violation — so this
    // pins that asymmetry against the fetchFailures/invalidEntries cases
    // above instead of leaving it able to drift either way unnoticed.
    const client = fakeClient([["style", "gone"]], {
      style: violation({ effectiveDirective: "style-src" }),
    });

    const summary = await createCspReportSummary(client).summarize();

    expect(summary.missingEntries).toBe(1);
    expect(summary.rollout.count).toBe(0);
    expect(summary.rollout.stopped).toBe(true);
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
});
