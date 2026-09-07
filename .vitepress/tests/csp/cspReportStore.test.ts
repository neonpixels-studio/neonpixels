import { describe, it, expect, vi } from "vitest";

import {
  createCspReportStore,
  type BlobWriter,
  type StoredCspViolation,
} from "../../../netlify/functions/lib/cspReportStore";
import type { CspViolation } from "../../csp/cspReportCollector";

function violation(overrides: Partial<CspViolation> = {}): CspViolation {
  return {
    documentUrl: "https://neonpixels.io/",
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
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.json$/);
    expect(value.effectiveDirective).toBe("script-src-elem");
    expect(value.blockedUri).toBe("inline");
    expect(typeof value.receivedAt).toBe("string");
    expect(() => new Date(value.receivedAt).toISOString()).not.toThrow();
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
