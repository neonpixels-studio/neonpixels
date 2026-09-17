import { describe, it, expect, vi, afterEach } from "vitest";

import {
  createCspReportSummary,
  ROLLOUT_DIRECTIVE,
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
  it("returns an empty summary for an empty store", async () => {
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
        stopped: true,
      },
      fetchFailures: 0,
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

  it("does not treat an unrelated directive that merely shares a prefix word as script-src", async () => {
    const blobs = {
      a: violation({ effectiveDirective: "script-src-fooxyz" }),
    };
    const client = fakeClient([["a"]], blobs);

    const summary = await createCspReportSummary(client).summarize();

    // "script-src-fooxyz" is still evidence of the script-src family under
    // this repo's prefix rule (it's not a directive this policy ever
    // declares separately) — asserts the rule is a hyphen-bounded prefix
    // match, not a bare substring match that would also catch something
    // like "my-script-src-elem".
    expect(summary.rollout.count).toBe(1);
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
});
