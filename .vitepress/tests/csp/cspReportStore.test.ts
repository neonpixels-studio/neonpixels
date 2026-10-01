import { describe, it, expect, vi } from "vitest";

import {
  compareByReceivedAt,
  createCspReportStore,
  keyClassOf,
  keyClassPrefix,
  receivedAtSortKey,
  sanitizeTimestamp,
  type BlobWriter,
  type StoredCspViolation,
} from "../../../netlify/functions/lib/cspReportStore";
import type { CspViolation } from "../../csp/cspReportCollector";

function violation(overrides: Partial<CspViolation> = {}): CspViolation {
  return {
    documentUrl: "https://neonpixels.dev/",
    effectiveDirective: "script-src-elem",
    blockedUri: "inline",
    disposition: "report",
    sourceFile: "",
    lineNumber: null,
    columnNumber: null,
    sample: "",
    ...overrides,
  };
}

function fakeBlobWriter(): BlobWriter & { setJSON: ReturnType<typeof vi.fn> } {
  return { setJSON: vi.fn().mockResolvedValue(undefined) };
}

describe("sanitizeTimestamp", () => {
  it("replaces the colon and period separators of an ISO timestamp with dashes", () => {
    expect(sanitizeTimestamp("2026-06-15T00:00:00.000Z")).toBe(
      "2026-06-15T00-00-00-000Z",
    );
  });
});

describe("createCspReportStore", () => {
  it("writes one blob per violation, stamped with when it was received", async () => {
    const blobWriter = fakeBlobWriter();
    const store = createCspReportStore(blobWriter);

    await store.persist([violation()]);

    expect(blobWriter.setJSON).toHaveBeenCalledTimes(1);
    const [key, value] = blobWriter.setJSON.mock.calls[0] as [
      string,
      StoredCspViolation,
    ];
    // Asserts the sanitized shape specifically (no `:` or `.` left over from
    // the raw ISO timestamp) and the `rollout/` key prefix (this violation's
    // `script-src-elem` directive is rollout-relevant - see keyClassOf) -
    // a looser pattern here would still pass if the
    // `.replace(/[:.]/g, "-")` sanitization or the class prefix in
    // violationKey were removed.
    expect(key).toMatch(
      /^rollout\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.json$/,
    );
    expect(value.effectiveDirective).toBe("script-src-elem");
    expect(value.blockedUri).toBe("inline");
    expect(typeof value.receivedAt).toBe("string");
    expect(() => new Date(value.receivedAt).toISOString()).not.toThrow();
  });

  it("prefixes a non-rollout violation's key with `other/` rather than `rollout/`", async () => {
    const blobWriter = fakeBlobWriter();
    const store = createCspReportStore(blobWriter);

    await store.persist([violation({ effectiveDirective: "img-src" })]);

    const [key] = blobWriter.setJSON.mock.calls[0] as [string];
    expect(key).toMatch(
      /^other\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.json$/,
    );
  });

  it("writes a batch of violations as distinct blobs with distinct keys", async () => {
    const blobWriter = fakeBlobWriter();
    const store = createCspReportStore(blobWriter);

    await store.persist([
      violation({ blockedUri: "inline" }),
      violation({ blockedUri: "https://evil.example/x.js" }),
    ]);

    expect(blobWriter.setJSON).toHaveBeenCalledTimes(2);
    const [firstKey] = blobWriter.setJSON.mock.calls[0] as [string];
    const [secondKey] = blobWriter.setJSON.mock.calls[1] as [string];
    expect(firstKey).not.toBe(secondKey);
  });

  it("does not write anything for an empty batch", async () => {
    const blobWriter = fakeBlobWriter();
    const store = createCspReportStore(blobWriter);

    await store.persist([]);

    expect(blobWriter.setJSON).not.toHaveBeenCalled();
  });

  it("propagates a write failure to the caller with the failed/total count", async () => {
    const blobWriter: BlobWriter = {
      setJSON: vi.fn().mockRejectedValue(new Error("blobs unavailable")),
    };
    const store = createCspReportStore(blobWriter);

    await expect(store.persist([violation()])).rejects.toThrow(
      /1\/1 csp violation writes failed.*blobs unavailable/,
    );
  });

  it("counts a partial failure against the full batch rather than discarding it", async () => {
    const setJSON = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("blobs unavailable"))
      .mockResolvedValueOnce(undefined);
    const store = createCspReportStore({ setJSON });

    await expect(
      store.persist([violation(), violation(), violation()]),
    ).rejects.toThrow(/1\/3 csp violation writes failed.*blobs unavailable/);
    expect(setJSON).toHaveBeenCalledTimes(3);
  });

  it("reports every distinct failure reason, not just the first", async () => {
    const setJSON = vi
      .fn()
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockRejectedValueOnce(new Error("key conflict"));
    const store = createCspReportStore({ setJSON });

    await expect(store.persist([violation(), violation()])).rejects.toThrow(
      /quota exceeded.*key conflict|key conflict.*quota exceeded/,
    );
  });
});

describe("keys written by persist", () => {
  it.each([
    ["script-src", "rollout"],
    ["connect-src", "other"],
  ])(
    "classify a %s violation's key as %s",
    async (effectiveDirective, expected) => {
      const blobWriter = fakeBlobWriter();
      const store = createCspReportStore(blobWriter);
      await store.persist([violation({ effectiveDirective })]);
      const [key] = blobWriter.setJSON.mock.calls[0] as [string];

      expect(keyClassOf(key)).toBe(expected);
    },
  );
});

describe("keyClassOf", () => {
  const timestamp = sanitizeTimestamp("2026-01-01T00:00:00.000Z");

  it.each([
    ["a rollout-prefixed key", `rollout/${timestamp}-uuid.json`, "rollout"],
    ["an other-prefixed key", `other/${timestamp}-uuid.json`, "other"],
    [
      "a legacy rollout-tagged key",
      `${timestamp}-rollout-${"a".repeat(36)}.json`,
      "rollout",
    ],
    [
      "a legacy other-tagged key",
      `${timestamp}-other-${"a".repeat(36)}.json`,
      "other",
    ],
    ["a legacy untagged key", `${timestamp}-${"a".repeat(36)}.json`, "rollout"],
  ])("classifies %s", (_label, key, expected) => {
    expect(keyClassOf(key)).toBe(expected);
  });

  it("treats a legacy untagged key as protected (rollout), the safer direction for evidence the pruner can't positively classify as irrelevant", () => {
    expect(keyClassOf(`${timestamp}-${"a".repeat(36)}.json`)).toBe("rollout");
  });

  it("treats a key matching no known shape as `other` (evictable), not permanently protected", () => {
    expect(keyClassOf(`${timestamp}-not-a-real-shape.json`)).toBe("other");
  });

  it("trusts the class prefix over a conflicting legacy-looking suffix", () => {
    expect(
      keyClassOf(`other/${timestamp}-rollout-${"a".repeat(36)}.json`),
    ).toBe("other");
  });

  it("builds the list prefix for a class with a trailing separator, so `other` can never match a different class sharing its leading letters", () => {
    expect(keyClassPrefix("rollout")).toBe("rollout/");
    expect(keyClassPrefix("other")).toBe("other/");
  });
});

describe("receivedAtSortKey / compareByReceivedAt", () => {
  const early = sanitizeTimestamp("2026-01-01T00:00:00.000Z");
  const late = sanitizeTimestamp("2026-02-01T00:00:00.000Z");

  it("strips a class prefix and leaves a legacy key untouched", () => {
    expect(receivedAtSortKey(`rollout/${early}-a.json`)).toBe(
      `${early}-a.json`,
    );
    expect(receivedAtSortKey(`${early}-a.json`)).toBe(`${early}-a.json`);
  });

  it("orders keys by timestamp across classes and formats, ignoring the prefix", () => {
    const keys = [
      `rollout/${late}-a.json`,
      `${early}-legacy.json`,
      `other/${late}-b.json`,
      `other/${early}-c.json`,
    ];

    // A plain `.sort()` would group by prefix (`other/` < `rollout/`) and put
    // the digit-leading legacy key first regardless of age.
    expect([...keys].sort(compareByReceivedAt)).toEqual([
      `other/${early}-c.json`,
      `${early}-legacy.json`,
      `rollout/${late}-a.json`,
      `other/${late}-b.json`,
    ]);
  });
});
