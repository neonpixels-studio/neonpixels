import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createCspReportPruner,
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

// A BlobPrunerClient backed by an in-memory key list and a real delete
// mock, so tests assert both the final result and exactly which keys were
// deleted, without touching `@netlify/blobs`.
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

    expect(result).toEqual({ deleted: 0, remaining: 0 });
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

    expect(result).toEqual({ deleted: 0, remaining: 3 });
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

    expect(result).toEqual({ deleted: 1, remaining: 2 });
    expect(deletedKeys(client)).toEqual([staleKey]);
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

    expect(result).toEqual({ deleted: 2, remaining: 3 });
    expect(deletedKeys(client)).toEqual([
      keyFromDaysAgo(5, "oldest"),
      keyFromDaysAgo(4, "older"),
    ]);
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
    expect(result).toEqual({ deleted: 5, remaining: 1 });
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

    expect(result).toEqual({ deleted: 1, remaining: 1 });
    expect(deletedKeys(client)).toEqual([pageOne[0]]);
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
});
