// Retention/cap enforcement for the csp-reports Blobs store, isolated from
// Netlify Blobs the same way cspReportStore.ts isolates the write path:
// `createCspReportPruner` takes anything shaped like the two Blobs methods it
// needs (list, delete), so the prune logic is unit-testable without the
// Netlify runtime; `getCspReportPruner` is the only place that touches
// `@netlify/blobs`.
//
// The public, unauthenticated /csp-report endpoint (see ../csp-report.ts) has
// no auth and only a per-request size/count cap, so sustained abuse can still
// grow the store without limit over time. This module is invoked on a daily
// schedule (see ../csp-report-prune.ts) and enforces two independent caps:
// - retentionDays: blobs older than this are always deleted.
// - maxBlobs: whatever remains after the age cut is trimmed to this count,
//   oldest first, so a flood that lands entirely inside the retention window
//   (e.g. a burst of thousands of reports in a single day) is still capped
//   rather than only aged out on the next cutoff.
import { getStore } from "@netlify/blobs";

import { CSP_REPORT_STORE_NAME, sanitizeTimestamp } from "./cspReportStore";

export type BlobListEntry = { key: string };
export type BlobPage = { blobs: BlobListEntry[] };

// The two Blobs capabilities pruning needs, so tests can inject a fake
// without mocking the `@netlify/blobs` module (mirrors BlobWriter's seam in
// cspReportStore.ts). `list` is typed to the `paginate: true` overload of the
// real Store so the pruner always walks every page rather than only the first.
export type BlobPrunerClient = {
  list(_options: { paginate: true }): AsyncIterable<BlobPage>;
  delete(_key: string): Promise<void>;
};

export type PruneResult = {
  deleted: number;
  remaining: number;
};

export type CspReportPruner = {
  prune(): Promise<PruneResult>;
};

export type PrunerOptions = {
  retentionDays: number;
  maxBlobs: number;
};

// Keys are `<sanitized ISO receivedAt>-<uuid>.json` (see violationKey in
// cspReportStore.ts). The sanitized timestamp is fixed-width, so slicing it
// off the front of every key and comparing two prefixes as plain strings
// orders keys chronologically without parsing each one back into a Date.
const RECEIVED_AT_PREFIX_LENGTH = sanitizeTimestamp(
  new Date(0).toISOString(),
).length;

function receivedAtPrefix(key: string): string {
  return key.slice(0, RECEIVED_AT_PREFIX_LENGTH);
}

function isStaleKey(key: string, cutoffPrefix: string): boolean {
  return receivedAtPrefix(key) < cutoffPrefix;
}

async function listAllKeys(client: BlobPrunerClient): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of client.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
  }
  return keys;
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

// Every distinct failure reason in the batch, so a mix of causes isn't
// collapsed into just the first one (mirrors describeFailures in
// cspReportStore.ts).
function describeFailures(failures: PromiseRejectedResult[]): string {
  const reasons = new Set(failures.map((failure) => String(failure.reason)));
  return [...reasons].join("; ");
}

async function deleteKeys(
  client: BlobPrunerClient,
  keys: string[],
): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const results = await Promise.allSettled(
    keys.map((key) => client.delete(key)),
  );
  const failures = results.filter(isRejected);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${results.length} csp report prune deletes failed: ${describeFailures(failures)}`,
    );
  }
  return keys.length;
}

// The oldest-first excess beyond maxBlobs, drawn only from keys that already
// survived the age cut, so a key is never counted toward both the stale and
// the over-cap deletion.
function overCapKeys(freshKeysOldestFirst: string[], maxBlobs: number) {
  const overflow = freshKeysOldestFirst.length - maxBlobs;
  return overflow > 0 ? freshKeysOldestFirst.slice(0, overflow) : [];
}

// Pure factory: given anything that can list and delete blobs, returns a
// pruner that deletes everything older than `retentionDays`, then trims the
// remainder to `maxBlobs`, oldest first.
export function createCspReportPruner(
  client: BlobPrunerClient,
  { retentionDays, maxBlobs }: PrunerOptions,
): CspReportPruner {
  return {
    async prune() {
      const keys = (await listAllKeys(client)).sort();
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const cutoffPrefix = sanitizeTimestamp(new Date(cutoffMs).toISOString());
      const staleKeys = keys.filter((key) => isStaleKey(key, cutoffPrefix));
      const freshKeys = keys.filter((key) => !isStaleKey(key, cutoffPrefix));
      const toDelete = [...staleKeys, ...overCapKeys(freshKeys, maxBlobs)];
      const deleted = await deleteKeys(client, toDelete);
      return { deleted, remaining: keys.length - deleted };
    },
  };
}

// Defaults, overridable via env for ops tuning without a code change. Netlify
// auto-configures Blobs itself (siteID/token injected at runtime), so
// neither variable is required for the pruner to run — only to move the
// retention window or the count cap away from these defaults.
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BLOBS = 5000;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The concrete adapter the scheduled function uses.
export function getCspReportPruner(): CspReportPruner {
  return createCspReportPruner(getStore(CSP_REPORT_STORE_NAME), {
    retentionDays: positiveIntEnv(
      "CSP_REPORT_RETENTION_DAYS",
      DEFAULT_RETENTION_DAYS,
    ),
    maxBlobs: positiveIntEnv("CSP_REPORT_MAX_BLOBS", DEFAULT_MAX_BLOBS),
  });
}
