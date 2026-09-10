// Retention/cap enforcement for the csp-reports Blobs store, isolated from
// Netlify Blobs the same way cspReportStore.ts isolates the write path:
// `createCspReportPruner` takes anything shaped like the two Blobs methods it
// needs (list, delete), so the prune logic is unit-testable without the
// Netlify runtime; `getCspReportPruner` is the only place that touches
// `@netlify/blobs`.
//
// The public, unauthenticated /csp-report endpoint (see ../csp-report.ts) has
// no auth and only a per-request size/count cap, so sustained abuse can still
// grow the store without limit over time. This module is invoked on an hourly
// schedule (see ../csp-report-prune.ts) and enforces two independent caps:
// - retentionDays: blobs older than this are always deleted.
// - maxBlobs: whatever remains after the age cut is trimmed to this count,
//   oldest first, so a flood that lands entirely inside the retention window
//   is still capped on the next scheduled run rather than only aged out once
//   the retention cutoff eventually reaches it.
// Both the list and the delete pass are budgeted against a wall-clock
// deadline (see PRUNE_TIME_BUDGET_MS) so a store big enough to need pruning
// can't make the run itself exceed the Function's execution limit — an
// unbudgeted pass would get killed mid-run, prune nothing, and repeat that
// failure on every later run. The hourly cadence keeps the per-run backlog
// small enough that hitting the deadline should be rare in practice.
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
  // Count of keys seen this run that are still present afterward. Only a
  // reliable total-store count when `complete` is true — an incomplete run
  // only saw part of the store, so this is the remainder of that partial view.
  remaining: number;
  // False when the list or delete pass hit the time budget before finishing.
  // The next scheduled run picks up where this one left off (stale keys are
  // still stale, and a re-list finds whatever wasn't reached).
  complete: boolean;
};

export type CspReportPruner = {
  prune(): Promise<PruneResult>;
};

export type PrunerOptions = {
  retentionDays: number;
  maxBlobs: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Conservative budget for the whole prune() call. Netlify's default synchronous
// Function execution limit is 10s; this leaves headroom for cold start and the
// final list/delete round-trip rather than racing the platform's own cutoff,
// which would kill the run mid-batch with no chance to log the outcome.
export const PRUNE_TIME_BUDGET_MS = 8000;

// Deletes are chunked rather than fired all at once so a store with tens of
// thousands of stale blobs doesn't send that many simultaneous requests in
// one Promise.allSettled — that pattern trips Blobs rate limits and turns a
// large-but-routine prune into a batch of failures. Exported so tests assert
// the real batch boundary instead of mirroring a magic number.
export const DELETE_BATCH_SIZE = 50;

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

type ListedKeys = { keys: string[]; complete: boolean };

// Walks every list() page up to the deadline. Stops early (complete: false)
// rather than exceeding the budget, so a store too large to fully list in one
// run still gets a partial prune instead of no prune at all.
async function listAllKeys(
  client: BlobPrunerClient,
  deadlineMs: number,
): Promise<ListedKeys> {
  const keys: string[] = [];
  for await (const page of client.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
    if (Date.now() > deadlineMs) {
      return { keys, complete: false };
    }
  }
  return { keys, complete: true };
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

type DeletedKeys = { deleted: number; complete: boolean };

// Deletes in fixed-size batches, checking the deadline between batches so a
// long delete pass yields a partial result instead of running past the
// Function's own execution limit. A failure within a batch still aborts the
// whole call (thrown, same contract as before) — only running out of time
// produces the softer `complete: false` outcome.
async function deleteKeys(
  client: BlobPrunerClient,
  keys: string[],
  deadlineMs: number,
): Promise<DeletedKeys> {
  let deleted = 0;
  let attempted = 0;
  const failures: PromiseRejectedResult[] = [];
  for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
    if (Date.now() > deadlineMs) {
      return { deleted, complete: false };
    }
    const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((key) => client.delete(key)),
    );
    attempted += batch.length;
    const batchFailures = results.filter(isRejected);
    failures.push(...batchFailures);
    deleted += batch.length - batchFailures.length;
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${attempted} csp report prune deletes failed: ${describeFailures(failures)}`,
    );
  }
  return { deleted, complete: true };
}

// The oldest-first excess beyond maxBlobs, drawn only from keys that already
// survived the age cut, so a key is never counted toward both the stale and
// the over-cap deletion.
function overCapKeys(freshKeysOldestFirst: string[], maxBlobs: number) {
  const overflow = freshKeysOldestFirst.length - maxBlobs;
  return overflow > 0 ? freshKeysOldestFirst.slice(0, overflow) : [];
}

// Sorted ascending, so every stale key (older than cutoffPrefix) sorts before
// every fresh one — a single findIndex splits the list in one pass instead of
// filtering it twice. The count cap is only applied when `enforceCap` is
// true (i.e. the list pass saw the whole store): capping against a partial
// view would evict keys that were never actually in excess.
function selectKeysToDelete(
  sortedKeys: string[],
  cutoffPrefix: string,
  maxBlobs: number,
  enforceCap: boolean,
): string[] {
  const firstFreshIndex = sortedKeys.findIndex(
    (key) => !isStaleKey(key, cutoffPrefix),
  );
  const staleKeys =
    firstFreshIndex === -1 ? sortedKeys : sortedKeys.slice(0, firstFreshIndex);
  const freshKeys =
    firstFreshIndex === -1 ? [] : sortedKeys.slice(firstFreshIndex);
  const capKeys = enforceCap ? overCapKeys(freshKeys, maxBlobs) : [];
  return [...staleKeys, ...capKeys];
}

// Pure factory: given anything that can list and delete blobs, returns a
// pruner that deletes everything older than `retentionDays`, then (once it
// has seen the whole store this run) trims the remainder to `maxBlobs`,
// oldest first.
export function createCspReportPruner(
  client: BlobPrunerClient,
  { retentionDays, maxBlobs }: PrunerOptions,
): CspReportPruner {
  return {
    async prune() {
      const deadlineMs = Date.now() + PRUNE_TIME_BUDGET_MS;
      const { keys: unsortedKeys, complete: listComplete } = await listAllKeys(
        client,
        deadlineMs,
      );
      const keys = unsortedKeys.sort();
      const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
      const cutoffPrefix = sanitizeTimestamp(new Date(cutoffMs).toISOString());
      const toDelete = selectKeysToDelete(
        keys,
        cutoffPrefix,
        maxBlobs,
        listComplete,
      );
      const { deleted, complete: deleteComplete } = await deleteKeys(
        client,
        toDelete,
        deadlineMs,
      );
      return {
        deleted,
        remaining: keys.length - deleted,
        complete: listComplete && deleteComplete,
      };
    },
  };
}

// Defaults, overridable via env for ops tuning without a code change. Netlify
// auto-configures Blobs itself (siteID/token injected at runtime), so
// neither variable is required for the pruner to run — only to move the
// retention window or the count cap away from these defaults.
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_BLOBS = 5000;
// Clamps a runaway CSP_REPORT_RETENTION_DAYS: `Date` only supports values
// within ~273,790 years of the epoch, so an absurd input (e.g. a stray extra
// zero) could otherwise push the cutoff outside that range and throw a
// RangeError on every single scheduled run, pruning nothing forever. 10 years
// is far beyond any real retention need for this store.
export const MAX_RETENTION_DAYS = 3650;

// Parses a positive-integer env var, falling back to `fallback` (and logging
// a marker) for anything unset, non-numeric, zero, negative or fractional —
// so a typo'd override degrades to the safe default with a visible trail
// instead of silently doing nothing or crashing the run. Exported so the
// unset/invalid/fallback behavior is unit-tested directly, without mocking
// `@netlify/blobs` just to exercise env parsing.
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  console.warn(
    "csp-report-prune-config-invalid",
    JSON.stringify({ name, raw }),
  );
  return fallback;
}

// Exported alongside positiveIntEnv so the MAX_RETENTION_DAYS clamp is
// unit-tested directly too.
export function resolveRetentionDays(): number {
  return Math.min(
    positiveIntEnv("CSP_REPORT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    MAX_RETENTION_DAYS,
  );
}

export function resolveMaxBlobs(): number {
  return positiveIntEnv("CSP_REPORT_MAX_BLOBS", DEFAULT_MAX_BLOBS);
}

// The concrete adapter the scheduled function uses.
export function getCspReportPruner(): CspReportPruner {
  return createCspReportPruner(getStore(CSP_REPORT_STORE_NAME), {
    retentionDays: resolveRetentionDays(),
    maxBlobs: resolveMaxBlobs(),
  });
}
