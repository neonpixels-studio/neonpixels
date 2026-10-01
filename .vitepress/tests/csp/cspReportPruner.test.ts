import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createCspReportPruner,
  positiveIntEnv,
  resolveRetentionDays,
  resolveMaxBlobs,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_BLOBS,
  MAX_RETENTION_DAYS,
  MAX_MAX_BLOBS,
  DELETE_BATCH_SIZE,
  LIST_TIME_BUDGET_MS,
  PRUNE_TIME_BUDGET_MS,
  type BlobListOptions,
  type BlobPrunerClient,
  type BlobPage,
} from "../../../netlify/functions/lib/cspReportPruner";
import {
  sanitizeTimestamp,
  keyClassPrefix,
} from "../../../netlify/functions/lib/cspReportStore";

const NOW = new Date("2026-06-15T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function keyFromMsAgo(msAgo: number, suffix: string): string {
  const receivedAt = new Date(NOW.getTime() - msAgo).toISOString();
  return `${sanitizeTimestamp(receivedAt)}-${suffix}.json`;
}

// Builds a key in the same shape violationKey() in cspReportStore.ts
// produces, timestamped `daysAgo` days before NOW, so tests can construct
// keys that land clearly on either side of a retention cutoff.
function keyFromDaysAgo(daysAgo: number, suffix: string): string {
  return keyFromMsAgo(daysAgo * DAY_MS, suffix);
}

// Builds a key in the current `<class>/<timestamp>-<suffix>.json` shape
// violationKey() in cspReportStore.ts writes, so eviction-priority tests can
// construct genuine script-src evidence and fabricated non-script-src flood
// entries that are listed per class prefix the same way the pruner does in
// production.
function taggedKeyFromMsAgo(
  msAgo: number,
  keyClass: "rollout" | "other",
  suffix: string,
): string {
  const receivedAt = new Date(NOW.getTime() - msAgo).toISOString();
  return `${keyClassPrefix(keyClass)}${sanitizeTimestamp(receivedAt)}-${suffix}.json`;
}

function taggedKeyFromDaysAgo(
  daysAgo: number,
  keyClass: "rollout" | "other",
  suffix: string,
): string {
  return taggedKeyFromMsAgo(daysAgo * DAY_MS, keyClass, suffix);
}

// A key in the pre-#165 mid-key tag shape: `<timestamp>-<tag>-<suffix>.json`,
// stored at the root of the store with no class prefix.
function legacyTaggedKeyFromDaysAgo(
  daysAgo: number,
  tag: "rollout" | "other",
  suffix: string,
): string {
  return keyFromDaysAgo(daysAgo, `${tag}-${suffix}`);
}

// Applies the same filtering real Blobs does for the two list options the
// pruner uses: `prefix` keeps keys starting with it, `directories` keeps only
// root-level keys (no `/`). Without this every group listing would return the
// whole fake store and keys would be counted once per group.
function keysMatchingListOptions(
  keys: string[],
  options: BlobListOptions,
): string[] {
  const prefixed = keys.filter((key) => key.startsWith(options.prefix ?? ""));
  return options.directories
    ? prefixed.filter((key) => !key.includes("/"))
    : prefixed;
}

// A BlobPrunerClient backed by an in-memory key list, split across the given
// pages, and a real delete mock, so tests assert both the final result and
// exactly which keys were deleted, without touching `@netlify/blobs`.
function fakeClient(
  pages: string[][],
): BlobPrunerClient & { delete: ReturnType<typeof vi.fn> } {
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  return {
    async *list(options) {
      for (const page of pages) {
        yield listedPage(page, options);
      }
    },
    delete: deleteMock,
  };
}

// One list() page as real Blobs would return it for these options.
function listedPage(keys: string[], options: BlobListOptions): BlobPage {
  return {
    blobs: keysMatchingListOptions(keys, options).map((key) => ({ key })),
  };
}

const LIST_GROUP_COUNT = 3;
const GROUP_SLICE_END_MS = {
  other: Math.floor(LIST_TIME_BUDGET_MS / LIST_GROUP_COUNT),
  rollout: Math.floor((LIST_TIME_BUDGET_MS * 2) / LIST_GROUP_COUNT),
  legacy: LIST_TIME_BUDGET_MS,
};

// Moves the clock just past one group's slice of the list budget while that
// group is being listed, and serves one more page that a truncated listing
// never reaches. The other groups still have budget left, so exactly one
// group comes back incomplete.
function truncatedGroupClient(
  keys: string[],
  truncatedGroup: keyof typeof GROUP_SLICE_END_MS,
): BlobPrunerClient & { delete: ReturnType<typeof vi.fn> } {
  const groupPrefix = {
    other: keyClassPrefix("other"),
    rollout: keyClassPrefix("rollout"),
    legacy: undefined,
  }[truncatedGroup];
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    async *list(options) {
      const isTruncatedListing =
        options.prefix === groupPrefix &&
        Boolean(options.directories) === (truncatedGroup === "legacy");
      if (!isTruncatedListing) {
        yield listedPage(keys, options);
        return;
      }
      vi.setSystemTime(
        new Date(NOW.getTime() + GROUP_SLICE_END_MS[truncatedGroup] + 1),
      );
      yield listedPage(keys, options);
      yield {
        blobs: [{ key: taggedKeyFromDaysAgo(1, "other", "never-seen") }],
      };
    },
  };
}

// Simulates a slow first page over a large store: the clock jumps past the
// whole list budget as listing starts, so every group stops after its first
// page - but the delete pass still has its own remaining budget to work with.
function budgetSpentClient(
  pages: string[][],
): BlobPrunerClient & { delete: ReturnType<typeof vi.fn> } {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    async *list(options) {
      vi.setSystemTime(new Date(NOW.getTime() + LIST_TIME_BUDGET_MS + 1));
      for (const page of pages) {
        yield listedPage(page, options);
      }
    },
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
  vi.restoreAllMocks();
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

  it("deletes a rollout-tagged key once it's past the retention window — the tag protects against the count cap, not against retention", async () => {
    // isRolloutKey's own protection is bounded by retention regardless of
    // tag; every existing stale-key test above uses an untagged key, which
    // passes only incidentally (untagged also reads as rollout). This is
    // the case that would actually catch a regression where a rollout tag
    // started exempting a key from the retention pass too.
    const staleRollout = taggedKeyFromDaysAgo(40, "rollout", "stale-evidence");
    const freshRollout = taggedKeyFromDaysAgo(1, "rollout", "fresh-evidence");
    const client = fakeClient([[staleRollout, freshRollout]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 100,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 1, remaining: 1, complete: true });
    expect(deletedKeys(client)).toEqual([staleRollout]);
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

  it("protects genuine script-src evidence from a flood of fabricated non-script-src reports, even though the evidence is the oldest key in the store (#135)", async () => {
    // The genuine rollout evidence: one real script-src violation, older
    // than every flood entry below — under plain oldest-first eviction this
    // would be first in line for deletion.
    const genuineEvidence = taggedKeyFromDaysAgo(10, "rollout", "genuine");
    // An attacker flooding the public, unauthenticated /csp-report endpoint
    // with fabricated non-script-src reports, all newer than the evidence
    // above, sized well past the count cap.
    const flood = Array.from({ length: 50 }, (_, index) =>
      taggedKeyFromDaysAgo(
        1,
        "other",
        `flood-${String(index).padStart(2, "0")}`,
      ),
    );
    const client = fakeClient([[genuineEvidence, ...flood]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    const deleted = deletedKeys(client);
    // 51 total over a cap of 10 = 41 deletes, every one of them a flood
    // entry — the genuine evidence must never appear here.
    expect(result).toEqual({ deleted: 41, remaining: 10, complete: true });
    expect(deleted).not.toContain(genuineEvidence);
    expect(deleted.every((key) => flood.includes(key))).toBe(true);
  });

  it("only reaches into rollout keys once every non-rollout fresh key is already evicted and the store is still over cap", async () => {
    const rolloutKeys = [
      taggedKeyFromDaysAgo(5, "rollout", "oldest-evidence"),
      taggedKeyFromDaysAgo(4, "rollout", "older-evidence"),
      taggedKeyFromDaysAgo(3, "rollout", "newest-evidence"),
    ];
    const otherKeys = [
      taggedKeyFromDaysAgo(2, "other", "a"),
      taggedKeyFromDaysAgo(1, "other", "b"),
    ];
    const client = fakeClient([[...rolloutKeys, ...otherKeys]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      // 5 total, cap of 2: both `other` keys go first, then the excess (1)
      // spills into the oldest rollout key.
      maxBlobs: 2,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 3, remaining: 2, complete: true });
    expect(deletedKeys(client)).toEqual([...otherKeys, rolloutKeys[0]]);
  });

  it("still enforces the count cap, oldest first, when every fresh key is rollout-tagged", async () => {
    // Guards the spill branch in overCapKeys: if a future change made
    // rollout keys entirely exempt from the count cap instead of merely
    // last-in-line, this is the case that would catch it — a flood that
    // forges every report as script-src-directed (the residual gap
    // isRolloutKey documents: the tag is self-reported) must not disable
    // maxBlobs altogether. Each key gets a distinct age (one minute apart)
    // rather than sharing a single timestamp, and the list handed to the
    // fake client is the reverse of oldest-first — otherwise this would
    // only prove the deleted keys came first in whatever order they were
    // supplied (or sorted lexicographically by suffix), not that eviction
    // is genuinely chronological.
    const rolloutKeysOldestFirst = Array.from({ length: 50 }, (_, index) =>
      taggedKeyFromMsAgo(
        (50 - index) * 60_000,
        "rollout",
        `flood-${String(index).padStart(2, "0")}`,
      ),
    );
    const client = fakeClient([[...rolloutKeysOldestFirst].reverse()]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 10,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 40, remaining: 10, complete: true });
    expect(deletedKeys(client)).toEqual(rolloutKeysOldestFirst.slice(0, 40));
  });

  it("treats a legacy, untagged key (written before #135 tagging existed) as protected rollout evidence, not as evictable-first", async () => {
    // A key in the pre-#135 shape: `<timestamp>-<uuid>.json`, no tag
    // segment. isRolloutKey only excludes a key explicitly tagged `other`,
    // so an untagged legacy key — which could be real script-src evidence
    // collected before this fix shipped — is not preferentially evicted
    // just because it predates tagging.
    const legacyKey = keyFromDaysAgo(
      10,
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const flood = Array.from({ length: 20 }, (_, index) =>
      taggedKeyFromDaysAgo(
        1,
        "other",
        `flood-${String(index).padStart(2, "0")}`,
      ),
    );
    const client = fakeClient([[legacyKey, ...flood]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 5,
    });

    const result = await pruner.prune();

    const deleted = deletedKeys(client);
    expect(result).toEqual({ deleted: 16, remaining: 5, complete: true });
    expect(deleted).not.toContain(legacyKey);
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

  it("stops listing at its own time budget, but still applies the count cap to the keys already found", async () => {
    const foundKeys = [
      taggedKeyFromDaysAgo(1, "other", "a"),
      taggedKeyFromDaysAgo(1, "other", "b"),
      taggedKeyFromDaysAgo(1, "other", "c"),
    ];
    const neverReachedKey = taggedKeyFromDaysAgo(1, "other", "never-reached");
    const client = budgetSpentClient([foundKeys, [neverReachedKey]]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 1,
    });

    const result = await pruner.prune();

    // The listing pass is incomplete, but the 3 keys it did find are still a
    // valid lower bound on the store's size: trimming to maxBlobs 1 still
    // deletes the oldest 2 of them, rather than leaving the cap disabled
    // just because the run couldn't see the whole store.
    expect(result).toEqual({ deleted: 2, remaining: 1, complete: false });
    expect(deletedKeys(client)).toEqual([foundKeys[0], foundKeys[1]]);
  });

  it("logs a marker when an incomplete `other` view forces eviction to spill into rollout keys, since unseen `other` keys may still exist", async () => {
    const rolloutKeys = [
      taggedKeyFromDaysAgo(2, "rollout", "evidence-a"),
      taggedKeyFromDaysAgo(1, "rollout", "evidence-b"),
    ];
    // The `other` listing is cut short before it saw anything, so this run
    // can't rule out a flood of `other` keys outside its view.
    const client = truncatedGroupClient(rolloutKeys, "other");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 1,
    });

    const result = await pruner.prune();

    expect(result.complete).toBe(false);
    expect(deletedKeys(client)).toEqual([rolloutKeys[0]]);
    expect(warn).toHaveBeenCalledWith(
      "csp-report-prune-rollout-evicted-on-partial-view",
      JSON.stringify({ rolloutKeysListed: 2 }),
    );
  });

  describe("per-class listing (#165)", () => {
    it("lists each key class by its own prefix, then the unprefixed legacy keys", async () => {
      const client = fakeClient([]);
      const list = vi.spyOn(client, "list");
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 10,
      });

      await pruner.prune();

      expect(list.mock.calls.map(([options]) => options)).toEqual([
        { paginate: true, prefix: "other/" },
        { paginate: true, prefix: "rollout/" },
        { paginate: true, directories: true },
      ]);
    });

    it("still evicts `other` keys ahead of rollout keys when the rollout listing is cut short", async () => {
      const otherKeys = [
        taggedKeyFromDaysAgo(3, "other", "a"),
        taggedKeyFromDaysAgo(2, "other", "b"),
      ];
      const rolloutKeys = [
        taggedKeyFromDaysAgo(5, "rollout", "evidence-a"),
        taggedKeyFromDaysAgo(4, "rollout", "evidence-b"),
        taggedKeyFromDaysAgo(1, "rollout", "evidence-c"),
      ];
      const client = truncatedGroupClient(
        [...rolloutKeys, ...otherKeys],
        "rollout",
      );
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 3,
      });

      const result = await pruner.prune();

      // The older rollout evidence must survive: under a single mixed
      // listing a truncated run could have seen only rollout keys.
      expect(result).toEqual({ deleted: 2, remaining: 3, complete: false });
      expect(deletedKeys(client)).toEqual(otherKeys);
    });

    it("does not log the partial-view marker when only the rollout listing was cut short, since every `other` key was seen", async () => {
      const otherKeys = [taggedKeyFromDaysAgo(2, "other", "a")];
      const rolloutKeys = [
        taggedKeyFromDaysAgo(4, "rollout", "evidence-a"),
        taggedKeyFromDaysAgo(3, "rollout", "evidence-b"),
      ];
      const client = truncatedGroupClient(
        [...rolloutKeys, ...otherKeys],
        "rollout",
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 1,
      });

      await pruner.prune();

      expect(deletedKeys(client)).toEqual([...otherKeys, rolloutKeys[0]]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs the partial-view marker when only the legacy listing was cut short, since legacy keys can hold `other` keys too", async () => {
      const rolloutKeys = [
        taggedKeyFromDaysAgo(2, "rollout", "evidence-a"),
        taggedKeyFromDaysAgo(1, "rollout", "evidence-b"),
      ];
      const client = truncatedGroupClient(rolloutKeys, "legacy");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 1,
      });

      const result = await pruner.prune();

      expect(result.complete).toBe(false);
      expect(deletedKeys(client)).toEqual([rolloutKeys[0]]);
      expect(warn).toHaveBeenCalledWith(
        "csp-report-prune-rollout-evicted-on-partial-view",
        JSON.stringify({ rolloutKeysListed: 2 }),
      );
    });

    it("skips the remaining group listings once the list budget is spent instead of paying one more request per group", async () => {
      const client = budgetSpentClient([[]]);
      const list = vi.spyOn(client, "list");
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 10,
      });

      const result = await pruner.prune();

      expect(result.complete).toBe(false);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("applies retention by timestamp to both classes, not by prefix", async () => {
      const staleOther = taggedKeyFromDaysAgo(40, "other", "stale");
      const staleRollout = taggedKeyFromDaysAgo(41, "rollout", "stale");
      const freshOther = taggedKeyFromDaysAgo(1, "other", "fresh");
      const freshRollout = taggedKeyFromDaysAgo(1, "rollout", "fresh");
      const client = fakeClient([
        [freshOther, staleOther, freshRollout, staleRollout],
      ]);
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 10,
      });

      const result = await pruner.prune();

      expect(result).toEqual({ deleted: 2, remaining: 2, complete: true });
      expect(deletedKeys(client)).toEqual([staleRollout, staleOther]);
    });
  });

  describe("legacy keys written before the class prefix (#165)", () => {
    it("still counts and prunes a legacy mid-key-tagged `other` key, interleaved by age with prefixed keys", async () => {
      // Oldest to newest `other` keys alternate formats, so this only passes
      // if eviction orders by timestamp across formats rather than listing
      // the prefixed group before the legacy one.
      const legacyOtherOld = legacyTaggedKeyFromDaysAgo(5, "other", "a");
      const prefixedOtherMid = taggedKeyFromDaysAgo(4, "other", "b");
      const legacyOtherNewer = legacyTaggedKeyFromDaysAgo(3, "other", "c");
      const prefixedOtherNewest = taggedKeyFromDaysAgo(2, "other", "d");
      const client = fakeClient([
        [
          prefixedOtherNewest,
          legacyOtherNewer,
          prefixedOtherMid,
          legacyOtherOld,
        ],
      ]);
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 1,
      });

      const result = await pruner.prune();

      expect(result).toEqual({ deleted: 3, remaining: 1, complete: true });
      expect(deletedKeys(client)).toEqual([
        legacyOtherOld,
        prefixedOtherMid,
        legacyOtherNewer,
      ]);
    });

    it("keeps legacy rollout-tagged and untagged keys protected behind every `other` key, in either format", async () => {
      const legacyRollout = legacyTaggedKeyFromDaysAgo(9, "rollout", "a");
      const legacyUntagged = keyFromDaysAgo(
        8,
        "550e8400-e29b-41d4-a716-446655440000",
      );
      const legacyOther = legacyTaggedKeyFromDaysAgo(2, "other", "b");
      const prefixedOther = taggedKeyFromDaysAgo(1, "other", "c");
      const client = fakeClient([
        [legacyRollout, legacyUntagged, legacyOther, prefixedOther],
      ]);
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 2,
      });

      const result = await pruner.prune();

      expect(result).toEqual({ deleted: 2, remaining: 2, complete: true });
      expect(deletedKeys(client)).toEqual([legacyOther, prefixedOther]);
    });

    it("ages a stale legacy key out by retention so it is not orphaned forever", async () => {
      const staleLegacy = legacyTaggedKeyFromDaysAgo(40, "rollout", "stale");
      const freshPrefixed = taggedKeyFromDaysAgo(1, "rollout", "fresh");
      const client = fakeClient([[staleLegacy, freshPrefixed]]);
      const pruner = createCspReportPruner(client, {
        retentionDays: 30,
        maxBlobs: 10,
      });

      const result = await pruner.prune();

      expect(result).toEqual({ deleted: 1, remaining: 1, complete: true });
      expect(deletedKeys(client)).toEqual([staleLegacy]);
    });
  });

  it("never calls delete when the list pass finds nothing before its own budget runs out", async () => {
    const client = budgetSpentClient([
      [],
      [taggedKeyFromDaysAgo(1, "other", "never-reached")],
    ]);
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: 5000,
    });

    const result = await pruner.prune();

    expect(result).toEqual({ deleted: 0, remaining: 0, complete: false });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("deletes stale keys before over-cap fresh keys when the delete deadline cuts a run short", async () => {
    // Zero-padded so the lexicographic `.sort()` inside prune() (these all
    // share the same 40-day-old timestamp) lands in the same order this
    // array is already in, letting the assertion below compare directly.
    const staleKeys = Array.from({ length: DELETE_BATCH_SIZE }, (_, index) =>
      keyFromDaysAgo(40, `stale-${String(index).padStart(2, "0")}`),
    );
    const freshKeys = Array.from({ length: 10 }, (_, index) =>
      keyFromDaysAgo(1, `fresh-${String(index).padStart(2, "0")}`),
    );
    let deleteCalls = 0;
    const deleteMock = vi.fn().mockImplementation(() => {
      deleteCalls += 1;
      // Once the first batch (all of staleKeys) finishes, the budget is
      // spent — the fresh, over-cap batch after it must never be attempted.
      if (deleteCalls === DELETE_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + PRUNE_TIME_BUDGET_MS + 1));
      }
      return Promise.resolve();
    });
    const client: BlobPrunerClient & { delete: typeof deleteMock } = {
      delete: deleteMock,
      async *list(options) {
        yield listedPage([...staleKeys, ...freshKeys], options);
      },
    };
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      // Low enough that every fresh key is also over the cap, so
      // selectKeysToDelete orders them as [...staleKeys, ...freshKeys] —
      // this proves deleteKeys' batching processes stale keys first.
      maxBlobs: 0,
    });

    const result = await pruner.prune();

    expect(result.complete).toBe(false);
    expect(deleteMock).toHaveBeenCalledTimes(DELETE_BATCH_SIZE);
    expect(deletedKeys(client)).toEqual(staleKeys);
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
      async *list(options) {
        yield listedPage(keys, options);
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

  it("throws delete failures gathered before the deadline instead of swallowing them as a mere timeout", async () => {
    const keys = Array.from({ length: DELETE_BATCH_SIZE * 2 }, (_, index) =>
      keyFromDaysAgo(40, `stale-${index}`),
    );
    let deleteCalls = 0;
    const deleteMock = vi.fn().mockImplementation(() => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        return Promise.reject(new Error("blobs unavailable"));
      }
      // By the last call in the first batch, the run is already out of time
      // — without accumulated-failure tracking this would silently report
      // `complete: false` and lose the one real failure above.
      if (deleteCalls === DELETE_BATCH_SIZE) {
        vi.setSystemTime(new Date(NOW.getTime() + PRUNE_TIME_BUDGET_MS + 1));
      }
      return Promise.resolve();
    });
    const client: BlobPrunerClient & { delete: typeof deleteMock } = {
      delete: deleteMock,
      async *list(options) {
        yield listedPage(keys, options);
      },
    };
    const pruner = createCspReportPruner(client, {
      retentionDays: 30,
      maxBlobs: keys.length * 10,
    });

    await expect(pruner.prune()).rejects.toThrow(
      new RegExp(
        `1/${DELETE_BATCH_SIZE} csp report prune deletes failed.*blobs unavailable`,
      ),
    );
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
    ["scientific notation", "1e21"],
    ["hexadecimal", "0x10"],
  ])("falls back and logs a config marker for a %s value", (_label, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(ENV_NAME, raw);

    expect(positiveIntEnv(ENV_NAME, 7)).toBe(7);

    expect(warn).toHaveBeenCalledWith(
      "csp-report-prune-config-invalid",
      JSON.stringify({ name: ENV_NAME, raw }),
    );
  });

  it("accepts a plain decimal too large to represent exactly, rather than falling back to the default", () => {
    // A well-formed but huge override must not be treated as worse than a
    // milder typo — resolveRetentionDays/resolveMaxBlobs are what clamp it
    // down to their MAX_* ceiling afterward (see the describe blocks below).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(ENV_NAME, "99999999999999999999");

    expect(positiveIntEnv(ENV_NAME, 7)).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
    expect(warn).not.toHaveBeenCalled();
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

  it("clamps an astronomically large override the same way as a milder one, not to the default", () => {
    // Exceeds Number.MAX_SAFE_INTEGER — the case that previously fell through
    // to DEFAULT_RETENTION_DAYS instead of MAX_RETENTION_DAYS, making a
    // bigger typo produce a smaller effective retention window than a
    // milder one.
    vi.stubEnv("CSP_REPORT_RETENTION_DAYS", "99999999999999999999");

    expect(resolveRetentionDays()).toBe(MAX_RETENTION_DAYS);
  });

  it("logs a config-clamped marker with the requested and applied values when clamping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("CSP_REPORT_RETENTION_DAYS", "1000000000");

    resolveRetentionDays();

    expect(warn).toHaveBeenCalledWith(
      "csp-report-prune-config-clamped",
      JSON.stringify({
        name: "CSP_REPORT_RETENTION_DAYS",
        requested: 1000000000,
        applied: MAX_RETENTION_DAYS,
      }),
    );
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

  it("clamps an override above MAX_MAX_BLOBS instead of effectively disabling the cap", () => {
    vi.stubEnv("CSP_REPORT_MAX_BLOBS", "999999999");

    expect(resolveMaxBlobs()).toBe(MAX_MAX_BLOBS);
  });

  it("clamps an astronomically large override the same way as a milder one, not to the default", () => {
    vi.stubEnv("CSP_REPORT_MAX_BLOBS", "99999999999999999999");

    expect(resolveMaxBlobs()).toBe(MAX_MAX_BLOBS);
  });

  it("logs a config-clamped marker with the requested and applied values when clamping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("CSP_REPORT_MAX_BLOBS", "999999999");

    resolveMaxBlobs();

    expect(warn).toHaveBeenCalledWith(
      "csp-report-prune-config-clamped",
      JSON.stringify({
        name: "CSP_REPORT_MAX_BLOBS",
        requested: 999999999,
        applied: MAX_MAX_BLOBS,
      }),
    );
  });
});
