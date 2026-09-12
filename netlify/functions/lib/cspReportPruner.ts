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
// - maxBlobs: whatever remains is trimmed to this count, oldest first. This
//   is applied even on a run that couldn't finish listing the whole store —
//   the partial count is still a valid lower bound on the real count, so
//   trimming `partialCount - maxBlobs` keys can never remove more than is
//   actually in excess.
// Both the list and the delete pass are budgeted against their own wall-clock
// deadline (see LIST_TIME_BUDGET_MS / PRUNE_TIME_BUDGET_MS) so a store big
// enough to need pruning can't make the run itself exceed the Function's
// execution limit — an unbudgeted pass would get killed mid-run, prune
// nothing, and repeat that failure on every later run. Splitting the budget
// (rather than one shared deadline) guarantees the delete pass always gets
// a share of the run even when listing alone would consume the whole thing.
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
  // False when the list or delete pass hit its time budget before finishing.
  // No cursor is persisted between runs, but this is still self-correcting:
  // the next hourly run re-lists from the start, and any key still stale or
  // still over the count cap gets picked up again then.
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

// Netlify scheduled Functions have a hard 30s execution limit (unlike a
// regular synchronous Function's default). PRUNE_TIME_BUDGET_MS leaves 5s of
// headroom under that for cold start and the final in-flight batch;
// LIST_TIME_BUDGET_MS caps listing at half of that so a large store can never
// consume the entire run and starve the delete pass of any time at all.
export const PRUNE_TIME_BUDGET_MS = 25000;
export const LIST_TIME_BUDGET_MS = Math.floor(PRUNE_TIME_BUDGET_MS / 2);

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

function isPastDeadline(deadlineMs: number): boolean {
  return Date.now() > deadlineMs;
}

type ListedKeys = { keys: string[]; complete: boolean };

// Walks every list() page up to its own deadline (see LIST_TIME_BUDGET_MS,
// deliberately shorter than the full run budget). Stops early
// (complete: false) rather than exceeding it, so a store too large to fully
// list in one run still leaves time for the delete pass below.
async function listAllKeys(
  client: BlobPrunerClient,
  deadlineMs: number,
): Promise<ListedKeys> {
  const keys: string[] = [];
  for await (const page of client.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
    if (isPastDeadline(deadlineMs)) {
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

type DeleteBatchOutcome = {
  deletedCount: number;
  failures: PromiseRejectedResult[];
};

async function deleteBatch(
  client: BlobPrunerClient,
  batch: string[],
): Promise<DeleteBatchOutcome> {
  const results = await Promise.allSettled(
    batch.map((key) => client.delete(key)),
  );
  const failures = results.filter(isRejected);
  return { deletedCount: batch.length - failures.length, failures };
}

// Throws once for every failure gathered so far, in the same "X/Y failed"
// shape regardless of whether the loop ran out of keys or ran out of time —
// a real Blobs error must never be swallowed just because the deadline hit
// on the same batch (or the one after) that produced it.
function throwIfAnyFailed(
  failures: PromiseRejectedResult[],
  attempted: number,
): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `${failures.length}/${attempted} csp report prune deletes failed: ${describeFailures(failures)}`,
  );
}

type DeletedKeys = { deleted: number; complete: boolean };

// Deletes in fixed-size batches, checking the deadline before each one so a
// long delete pass yields a partial result instead of running past the
// Function's own execution limit — the deadline check lives in the loop
// condition rather than as a branch in the body, so stopping early and
// finishing normally are the same exit, not two separate return points.
// Every batch is attempted regardless of earlier failures (mirrors persist()
// in cspReportStore.ts — one bad key must not stop the rest from being
// cleaned up); every failure gathered so far is thrown once at the end,
// whether the loop finished normally or was cut short by the deadline, so a
// real Blobs error is never swallowed just because time also ran out.
async function deleteKeys(
  client: BlobPrunerClient,
  keys: string[],
  deadlineMs: number,
): Promise<DeletedKeys> {
  let deleted = 0;
  let attempted = 0;
  let start = 0;
  const failures: PromiseRejectedResult[] = [];
  while (start < keys.length && !isPastDeadline(deadlineMs)) {
    const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
    const outcome = await deleteBatch(client, batch);
    attempted += batch.length;
    deleted += outcome.deletedCount;
    failures.push(...outcome.failures);
    start += batch.length;
  }
  throwIfAnyFailed(failures, attempted);
  return { deleted, complete: start >= keys.length };
}

// The oldest-first excess beyond maxBlobs. Safe to apply even against a
// partial (incomplete-listing) view: the count of keys actually seen is a
// lower bound on the real store size, so trimming `seen - maxBlobs` of them
// can never remove more than is genuinely in excess.
function overCapKeys(freshKeysOldestFirst: string[], maxBlobs: number) {
  const overflow = freshKeysOldestFirst.length - maxBlobs;
  return overflow > 0 ? freshKeysOldestFirst.slice(0, overflow) : [];
}

// Sorted ascending, so every stale key (older than cutoffPrefix) sorts before
// every fresh one — a single findIndex splits the list in one pass instead of
// filtering it twice.
function selectKeysToDelete(
  sortedKeys: string[],
  cutoffPrefix: string,
  maxBlobs: number,
): string[] {
  const firstFreshIndex = sortedKeys.findIndex(
    (key) => !isStaleKey(key, cutoffPrefix),
  );
  const splitIndex =
    firstFreshIndex === -1 ? sortedKeys.length : firstFreshIndex;
  const staleKeys = sortedKeys.slice(0, splitIndex);
  const freshKeys = sortedKeys.slice(splitIndex);
  return [...staleKeys, ...overCapKeys(freshKeys, maxBlobs)];
}

// Pure factory: given anything that can list and delete blobs, returns a
// pruner that deletes everything older than `retentionDays`, then trims
// whatever it saw down to `maxBlobs`, oldest first.
export function createCspReportPruner(
  client: BlobPrunerClient,
  { retentionDays, maxBlobs }: PrunerOptions,
): CspReportPruner {
  return {
    async prune() {
      const startMs = Date.now();
      const listDeadlineMs = startMs + LIST_TIME_BUDGET_MS;
      const deleteDeadlineMs = startMs + PRUNE_TIME_BUDGET_MS;
      const { keys: unsortedKeys, complete: listComplete } = await listAllKeys(
        client,
        listDeadlineMs,
      );
      const keys = unsortedKeys.sort();
      const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
      const cutoffPrefix = sanitizeTimestamp(new Date(cutoffMs).toISOString());
      const toDelete = selectKeysToDelete(keys, cutoffPrefix, maxBlobs);
      const { deleted, complete: deleteComplete } = await deleteKeys(
        client,
        toDelete,
        deleteDeadlineMs,
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
// Clamps a runaway CSP_REPORT_MAX_BLOBS the same way: an absurdly large value
// would still pass integer validation but effectively disable the count cap,
// defeating the reason this module exists.
export const MAX_MAX_BLOBS = 1_000_000;

// Matches a bare, non-negative decimal integer only — rejects scientific
// notation ("1e21"), hex ("0x10"), and anything with a sign or decimal point,
// each of which `Number()` would otherwise silently accept as a "valid"
// integer.
const PLAIN_DECIMAL_PATTERN = /^\d+$/;

// Parses a positive-integer env var, falling back to `fallback` (and logging
// a marker) for anything unset, zero, or not a plain decimal integer — so a
// typo'd or adversarial override degrades to the safe default with a visible
// trail instead of silently doing nothing or crashing the run. A value too
// large to represent exactly as a double is still accepted (as a large but
// finite number) rather than falling back: `resolveRetentionDays` and
// `resolveMaxBlobs` clamp it afterward, so an enormous override still lands
// on the intended MAX_* ceiling instead of unexpectedly dropping all the way
// to the default — a bigger typo must never produce a smaller effective
// limit than a milder one. Exported so this behavior is unit-tested
// directly, without mocking `@netlify/blobs` just to exercise env parsing.
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = PLAIN_DECIMAL_PATTERN.test(raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  console.warn(
    "csp-report-prune-config-invalid",
    JSON.stringify({ name, raw }),
  );
  return fallback;
}

// Applies `positiveIntEnv`'s ceiling and logs when it actually changes the
// value, so an operator who sets e.g. CSP_REPORT_MAX_BLOBS well above
// MAX_MAX_BLOBS sees why the effective cap is lower than what they asked
// for, instead of the clamp happening invisibly.
function clampedEnv(name: string, requested: number, max: number): number {
  if (requested <= max) {
    return requested;
  }
  console.warn(
    "csp-report-prune-config-clamped",
    JSON.stringify({ name, requested, applied: max }),
  );
  return max;
}

// Exported alongside positiveIntEnv so the MAX_RETENTION_DAYS clamp is
// unit-tested directly too.
export function resolveRetentionDays(): number {
  return clampedEnv(
    "CSP_REPORT_RETENTION_DAYS",
    positiveIntEnv("CSP_REPORT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    MAX_RETENTION_DAYS,
  );
}

export function resolveMaxBlobs(): number {
  return clampedEnv(
    "CSP_REPORT_MAX_BLOBS",
    positiveIntEnv("CSP_REPORT_MAX_BLOBS", DEFAULT_MAX_BLOBS),
    MAX_MAX_BLOBS,
  );
}

// The concrete adapter the scheduled function uses.
export function getCspReportPruner(): CspReportPruner {
  return createCspReportPruner(getStore(CSP_REPORT_STORE_NAME), {
    retentionDays: resolveRetentionDays(),
    maxBlobs: resolveMaxBlobs(),
  });
}
