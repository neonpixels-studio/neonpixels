import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createCspReportPruner,
  positiveIntEnv,
  resolveRetentionDays,
  resolveMaxBlobs,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_BLOBS,
  MAX_RETENTION_DAYS,
  DELETE_BATCH_SIZE,
  PRUNE_TIME_BUDGET_MS,
  type BlobPrunerClient,
  type BlobPage,
} from "../../../netlify/functions/lib/cspReportPruner";
import { sanitizeTimestamp } from "../../../netlify/functions/lib/cspReportStore";

const NOW = new Date("2026-06-15T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// Builds a key in the same shape violationKey() in cspReportStore.ts
// produces, timestamped `daysAgo` days before NOW, so tests can construct
// keys that land clearly on either side of a retention cutoff.
function keyFromDaysAgo(daysAgo: number, suffix: string): string {
  const receivedAt = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
  return `${sanitizeTimestamp(receivedAt)}-${suffix}.json`;
}

function keyFromMsAgo(msAgo: number, suffix: string): string {
  const receivedAt = new Date(NOW.getTime() - msAgo).toISOString();
  return `${sanitizeTimestamp(receivedAt)}-${suffix}.json`;
}

// A BlobPrunerClient backed by an in-memory key list, split across the given
// pages, and a real delete mock, so tests assert both the final result and
// exactly which keys were deleted, without touching `@netlify/blobs`.
function fakeClient(
  pages: string[][],
): BlobPrunerClient & { delete: ReturnType<typeof vi.fn> } {
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  return {
    async *list() {
      for (const page of pages) {
        yield {
          blobs: page.map((key) => ({ key }) as BlobPage["blobs"][number]),
        };
      }
    },
    delete: deleteMock,
  };
}

function deletedKeys(client: { delete: ReturnType<typeof vi.fn> }): string[] {
  return client.delete.mock.calls.map((call) => call[0] as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCspReportPruner", () => {
  it("does nothing when the store is empty", async () => {
    const client = fakeClient([]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 5000,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 0, remaining: 0, complete: true });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("keeps everything when under both the retention window and the max count cap", async () => {
    const client = fakeClient([
      [keyFromDaysAgo(1, "a"), keyFromDaysAgo(2, "b"), keyFromDaysAgo(3, "c")],
    ]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 0, remaining: 3, complete: true });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("deletes only blobs older than the retention window", async () => {
    const staleKey = keyFromDaysAgo(40, "stale");
    const freshKeys = [keyFromDaysAgo(1, "a"), keyFromDaysAgo(2, "b")];
    const client = fakeClient([[staleKey, ...freshKeys]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 1, remaining: 2, complete: true });
    expect(deletedKeys(client)).toEqual([staleKey]);
  });

  it("keeps a blob exactly at the retention cutoff, and deletes one a millisecond older", async () => {
    const atCutoffKey = keyFromDaysAgo(30, "at-cutoff");
    const justOverKey = keyFromMsAgo(30 * DAY_MS + 1, "just-over");
    const client = fakeClient([[atCutoffKey, justOverKey]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 1, remaining: 1, complete: true });
    expect(deletedKeys(client)).toEqual([justOverKey]);
  });

  it("evicts the oldest blobs first when over the max count cap, even though none are stale", async () => {
    const keys = [
      keyFromDaysAgo(5, "oldest"),
      keyFromDaysAgo(4, "older"),
      keyFromDaysAgo(3, "mid"),
      keyFromDaysAgo(2, "newer"),
      keyFromDaysAgo(1, "newest"),
    ];
    const client = fakeClient([keys]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 3,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 2, remaining: 3, complete: true });
    expect(deletedKeys(client)).toEqual([
      keyFromDaysAgo(5, "oldest"),
      keyFromDaysAgo(4, "older"),
    ]);
  });

  it("sorts keys chronologically across list pages, regardless of the order list() returns them in", async () => {
    const oldest = keyFromDaysAgo(5, "oldest");
    const mid = keyFromDaysAgo(3, "mid");
    const newest = keyFromDaysAgo(1, "newest");
    // Deliberately out of chronological order, and split across pages, so
    // this fails if the `.sort()` in prune() were ever removed — without it,
    // oldest-first eviction would key off list()/page order instead, which
    // Netlify Blobs documents no guarantee about.
    const client = fakeClient([[newest], [oldest, mid]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 2,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 1, remaining: 2, complete: true });
    expect(deletedKeys(client)).toEqual([oldest]);
  });

  it("never double-deletes a key that is both stale and beyond the cap", async () => {
    const staleKeys = [
      keyFromDaysAgo(50, "s1"),
      keyFromDaysAgo(45, "s2"),
      keyFromDaysAgo(40, "s3"),
    ];
    const freshKeys = [
      keyFromDaysAgo(3, "f1"),
      keyFromDaysAgo(2, "f2"),
      keyFromDaysAgo(1, "f3"),
    ];
    const client = fakeClient([[...staleKeys, ...freshKeys]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 1,
    });

    const result = await pruner.prune();

    // 3 stale (age) + 2 fresh over the cap of 1 = 5 unique deletes, no overlap.
    expect(result).toEqual({ deleted: 5, remaining: 1, complete: true });
    const deleted = deletedKeys(client);
    expect(deleted).toHaveLength(new Set(deleted).size);
    expect(deleted).toHaveLength(5);
  });

  it("paginates through multiple list pages before pruning", async () => {
    const pageOne = [keyFromDaysAgo(40, "stale-page1")];
    const pageTwo = [keyFromDaysAgo(1, "fresh-page2")];
    const client = fakeClient([pageOne, pageTwo]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 1, remaining: 1, complete: true });
    expect(deletedKeys(client)).toEqual([pageOne[0]]);
  });

  it("deletes every stale key across multiple delete batches when time allows", async () => {
    const keys = Array.from({ length: DELETE_BATCH_SIZE + 10 }, (_, index) =>
      keyFromDaysAgo(40, `stale-${index}`),
    );
    const client = fakeClient([keys]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 100000,
    });

    const result = await pruner.prune();

    expect(result).toEqual({
      deleted: keys.length,
      remaining: 0,
      complete: true,
    });
    expect(client.delete).toHaveBeenCalledTimes(keys.length);
  });

  it("propagates delete failures with the failed/total count", async () => {
    const key = keyFromDaysAgo(40, "stale");
    const client = fakeClient([[key]]);
    client.delete.mockRejectedValueOnce(new Error("blobs unavailable"));
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    await expect(pruner.prune()).rejects.toThrow(
      /1\/1 csp report prune deletes failed.*blobs unavailable/,
    );
  });

  it("reports every distinct delete failure reason, not just the first", async () => {
    const keys = [keyFromDaysAgo(40, "a"), keyFromDaysAgo(41, "b")];
    const client = fakeClient([keys]);
    client.delete
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockRejectedValueOnce(new Error("key conflict"));
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    await expect(pruner.prune()).rejects.toThrow(
      /quota exceeded.*key conflict|key conflict.*quota exceeded/,
    );
  });

  it("stops listing at the time budget and skips the count cap on the resulting partial view", async () => {
    const foundKeys = [
      keyFromDaysAgo(1, "a"),
      keyFromDaysAgo(1, "b"),
      keyFromDaysAgo(1, "c"),
    ];
    const neverReachedKey = keyFromDaysAgo(1, "never-reached");
    const client: BlobPrunerClient & { delete: ReturnType<typeof vi.fn> } = {
      delete: vi.fn().mockResolvedValue(undefined),
      // Simulates a slow first page over a large store: by the time it
      // arrives, the budget is already spent, so the pruner must stop
      // before requesting the next page.
      async *list() {
        vi.setSystemTime(new Date(NOW.getTime() + PRUNE_TIME_BUDGET_MS + 1));
        yield { blobs: foundKeys.map((key) => ({ key })) };
        yield { blobs: [{ key: neverReachedKey }] };
      },
    };
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      // A cap this low would evict 2 of the 3 found keys if the count cap
      // were (wrongly) enforced against a partial view.
      maxBlobs: 1,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 0, remaining: 3, complete: false });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("stops deleting at the time budget and reports an incomplete run", async () => {
    const keys = Array.from({ length: DELETE_BATCH_SIZE * 2 }, (_, index) =>
      keyFromDaysAgo(40, `stale-${index}`),
    );
    let deleteCalls = 0;
    const deleteMock = vi.fn().mockImplementation(() => {
      deleteCalls += 1;
      // Once the first batch finishes, the budget is spent — the second
      // batch must never be attempted.
      if (deleteCalls === DELETE_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + PRUNE_TIME_BUDGET_MS + 1));
      }
      return Promise.resolve();
    });
    const client: BlobPrunerClient & { delete: typeof deleteMock } = {
      delete: deleteMock,
      async *list() {
        yield { blobs: keys.map((key) => ({ key })) };
      },
    };
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: keys.length * 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({
      deleted: DELETE_BATCH_SIZE,
      remaining: keys.length - DELETE_BATCH_SIZE,
      complete: false,
    });
    expect(deleteMock).toHaveBeenCalledTimes(DELETE_BATCH_SIZE);
  });
});

describe("positiveIntEnv", () => {
  const ENV_NAME = "CSP_REPORT_TEST_VALUE";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fallback when the variable is unset", () => {
    expect(positiveIntEnv(ENV_NAME, 7)).toBe(7);
  });

  it("returns the parsed value for a valid positive integer", () => {
    vi.stubEnv(ENV_NAME, "42");

    expect(positiveIntEnv(ENV_NAME, 7)).toBe(42);
  });

  it.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "2.5"],
  ])("falls back and logs a config marker for a %s value", (_label, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(ENV_NAME, raw);

    expect(positiveIntEnv(ENV_NAME, 7)).toBe(7);

    expect(warn).toHaveBeenCalledWith(
      "csp-report-prune-config-invalid",
      JSON.stringify({ name: ENV_NAME, raw }),
    );
  });
});

describe("resolveRetentionDays", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to DEFAULT_RETENTION_DAYS when unset", () => {
    expect(resolveRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("honors a valid override under the clamp", () => {
    vi.stubEnv("CSP_REPORT_RETENTION_DAYS", "90");

    expect(resolveRetentionDays()).toBe(90);
  });

  it("clamps an override above MAX_RETENTION_DAYS instead of letting the cutoff Date overflow", () => {
    vi.stubEnv("CSP_REPORT_RETENTION_DAYS", "1000000000");

    expect(resolveRetentionDays()).toBe(MAX_RETENTION_DAYS);
  });
});

describe("resolveMaxBlobs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to DEFAULT_MAX_BLOBS when unset", () => {
    expect(resolveMaxBlobs()).toBe(DEFAULT_MAX_BLOBS);
  });

  it("honors a valid override", () => {
    vi.stubEnv("CSP_REPORT_MAX_BLOBS", "250");

    expect(resolveMaxBlobs()).toBe(250);
  });
});
