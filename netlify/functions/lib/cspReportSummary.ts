// Read/summary path for the csp-reports Blobs store, isolated from Netlify
// Blobs the same way cspReportStore.ts (write) and cspReportPruner.ts
// (retention) isolate their own seams. Neither of those answers the question
// the store exists for: which directives/blocked URIs are still firing, and
// specifically whether the script-src rollout's violations (see the `@todo`
// in netlify.toml and the README's CSP violation collector section) have
// actually stopped. `createCspReportSummary` takes anything shaped like the
// two Blobs methods it needs (list, get) so the aggregation is unit-tested
// without the Netlify runtime; `getCspReportSummary` is the only place that
// touches `@netlify/blobs`. The adapter that actually invokes this lives in
// ../csp-report-summary.ts (a scheduled Function, not a public route — see
// that file for why).
import { getStore } from "@netlify/blobs";

import { CSP_REPORT_STORE_NAME } from "./cspReportStore";
import type { StoredCspViolation } from "./cspReportStore";

export type BlobListEntry = { key: string };
export type BlobPage = { blobs: BlobListEntry[] };

// The two Blobs capabilities summarizing needs, so tests can inject a fake
// without mocking the `@netlify/blobs` module (mirrors `BlobWriter` in
// cspReportStore.ts and `BlobPrunerClient` in cspReportPruner.ts). `list` is
// typed to the `paginate: true` overload so the summary always walks every
// page, not just the first.
export type BlobSummaryClient = {
  list(_options: { paginate: true }): AsyncIterable<BlobPage>;
  get(_key: string, _options: { type: "json" }): Promise<unknown>;
};

// The directive this repo's rollout is watching. Once it stops firing over
// the observation window, `'unsafe-inline'` can be dropped from the
// enforcing `script-src` in netlify.toml.
export const ROLLOUT_DIRECTIVE = "script-src";

export type DirectiveCount = { directive: string; count: number };
export type BlockedUriCount = { blockedUri: string; count: number };

export type RolloutSignal = {
  directive: string;
  count: number;
  // null once `count` is 0 — nothing to point at.
  mostRecent: StoredCspViolation | null;
  stopped: boolean;
};

export type CspReportSummary = {
  // Every key the store listed, regardless of whether it fetched or parsed
  // successfully — the denominator for fetchFailures/missingEntries/
  // invalidEntries below.
  totalListed: number;
  totalViolations: number;
  // Descending by count (ties broken alphabetically for a deterministic
  // order), so the loudest directive/URI is first without the caller
  // re-sorting.
  byDirective: DirectiveCount[];
  byBlockedUri: BlockedUriCount[];
  rollout: RolloutSignal;
  // A get() that threw for a listed key (network hiccup, Blobs outage,
  // etc). Counted rather than thrown so one bad key can't blank out an
  // otherwise-good summary; logged via csp-report-summary-fetch-failed so
  // the gap is still visible. summarizeRollout treats any non-zero count
  // here as "can't tell", not "no violations" — a violation hidden behind a
  // failed fetch might have been script-src.
  fetchFailures: number;
  // A key `list()` returned that `get()` resolved as gone by the time this
  // run reached it (Netlify Blobs resolves a missing key to `null` rather
  // than throwing) — most often the hourly pruner deleting it mid-walk, not
  // a data problem. Tracked separately from invalidEntries below and never
  // logged: a key vanishing between list and get is routine, not evidence
  // of a corrupted blob.
  missingEntries: number;
  // A key that fetched something other than `null` but didn't parse as a
  // StoredCspViolation (a corrupted blob, or a future incompatible shape).
  // Logged via csp-report-summary-invalid-entry for the same reason as
  // fetchFailures.
  invalidEntries: number;
};

export type CspReportSummaryTool = {
  summarize(): Promise<CspReportSummary>;
};

async function listAllKeys(client: BlobSummaryClient): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of client.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
  }
  return keys;
}

// cspReportStore.ts always writes `receivedAt` as `new Date().toISOString()`
// (see violationKey/persist in that file) — it is never taken from the
// request body, so this isn't a defense against a forged value, only against
// shape drift (a future migration or a hand-edited blob storing something
// else). `mostRecentOf` below depends on lexicographic ISO ordering, so a
// non-ISO string sorting arbitrarily against real timestamps would silently
// point `rollout.mostRecent` at the wrong violation.
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Checked against every field StoredCspViolation declares, not just the ones
// this module reads today: a half-shaped record (missing `sample` or
// `disposition`, say) must not be accepted as `ok` and forwarded — with
// `undefined` fields — into rollout.mostRecent and the summarized log line,
// the exact record a rollout decision gets read from.
function isStoredCspViolation(value: unknown): value is StoredCspViolation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.documentUrl === "string" &&
    typeof record.effectiveDirective === "string" &&
    typeof record.blockedUri === "string" &&
    typeof record.disposition === "string" &&
    typeof record.sourceFile === "string" &&
    (record.lineNumber === null || typeof record.lineNumber === "number") &&
    (record.columnNumber === null || typeof record.columnNumber === "number") &&
    typeof record.sample === "string" &&
    typeof record.receivedAt === "string" &&
    ISO_TIMESTAMP_PATTERN.test(record.receivedAt)
  );
}

type FetchOutcome =
  | { status: "ok"; violation: StoredCspViolation }
  // `get()` resolved the key as gone (Netlify Blobs returns `null`, it
  // doesn't throw), most often the hourly pruner deleting it mid-walk.
  | { status: "missing"; key: string }
  | { status: "invalid"; key: string }
  | { status: "failed"; key: string; reason: unknown };

async function fetchOne(
  client: BlobSummaryClient,
  key: string,
): Promise<FetchOutcome> {
  let raw: unknown;
  try {
    raw = await client.get(key, { type: "json" });
  } catch (reason) {
    return { status: "failed", key, reason };
  }
  if (raw === null) {
    return { status: "missing", key };
  }
  if (isStoredCspViolation(raw)) {
    return { status: "ok", violation: raw };
  }
  return { status: "invalid", key };
}

const SUMMARY_FETCH_FAILED_LOG_PREFIX = "csp-report-summary-fetch-failed";
const SUMMARY_INVALID_ENTRY_LOG_PREFIX = "csp-report-summary-invalid-entry";

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

// A "missing" outcome is deliberately not logged here (unlike failed/
// invalid): a key vanishing between list() and get() is the pruner doing
// its job, not a fault worth a warning marker on every run that overlaps it.
function logFetchOutcome(outcome: FetchOutcome): void {
  if (outcome.status === "failed") {
    console.warn(
      SUMMARY_FETCH_FAILED_LOG_PREFIX,
      JSON.stringify({
        key: outcome.key,
        message: reasonMessage(outcome.reason),
      }),
    );
    return;
  }
  if (outcome.status === "invalid") {
    console.warn(
      SUMMARY_INVALID_ENTRY_LOG_PREFIX,
      JSON.stringify({ key: outcome.key }),
    );
  }
}

function isOk(
  outcome: FetchOutcome,
): outcome is Extract<FetchOutcome, { status: "ok" }> {
  return outcome.status === "ok";
}

function countStatus(
  outcomes: FetchOutcome[],
  status: FetchOutcome["status"],
): number {
  return outcomes.filter((outcome) => outcome.status === status).length;
}

// Plain code-unit ordering rather than `localeCompare`: directive names are
// ASCII, but blocked-uri keys are attacker-supplied and can contain
// non-ASCII text, and `localeCompare` output for that depends on the host's
// ICU data — a small-ICU Node build could order the same store differently
// than a full-ICU one. A tie-break only needs to be deterministic, not
// locale-aware.
function byKeyAscending(
  first: { key: string },
  second: { key: string },
): number {
  if (first.key < second.key) {
    return -1;
  }
  if (first.key > second.key) {
    return 1;
  }
  return 0;
}

// Counts violations by an arbitrary field, then orders the result descending
// by count (tie-broken by byKeyAscending) so both the directive and
// blocked-uri breakdowns share one sort rule instead of drifting apart.
function sortedCountsBy(
  violations: StoredCspViolation[],
  keyOf: (_violation: StoredCspViolation) => string,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const key = keyOf(violation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort(
      (first, second) =>
        second.count - first.count || byKeyAscending(first, second),
    );
}

function aggregateByDirective(
  violations: StoredCspViolation[],
): DirectiveCount[] {
  return sortedCountsBy(
    violations,
    (violation) => violation.effectiveDirective,
  ).map(({ key, count }) => ({ directive: key, count }));
}

function aggregateByBlockedUri(
  violations: StoredCspViolation[],
): BlockedUriCount[] {
  return sortedCountsBy(violations, (violation) => violation.blockedUri).map(
    ({ key, count }) => ({ blockedUri: key, count }),
  );
}

// Browsers report the specific sub-directive a violation matched
// (script-src-elem, script-src-attr) even when only the parent script-src is
// declared in the policy — this site's CSP never sets those sub-directives
// separately (see netlify.toml), so any of the three is evidence against the
// same script-src rollout. An exact-match-only check would silently miss
// most real violations and falsely read the rollout as clean.
function isRolloutDirective(directive: string): boolean {
  return (
    directive === ROLLOUT_DIRECTIVE ||
    directive.startsWith(`${ROLLOUT_DIRECTIVE}-`)
  );
}

// The single most recent violation, so the rollout signal can report the
// latest offender without sorting the whole matched array just to read
// index 0. `receivedAt` is an ISO timestamp, so a plain string comparison
// orders it correctly without parsing to a Date (mirrors the trick
// cspReportPruner.ts uses on the sanitized key). A `.sort()` comparator that
// never returns 0 for equal timestamps (realistic here — one blocked inline
// script can fire several reports in the same millisecond) is an
// inconsistent comparator with implementation-defined results, so this
// reduces instead.
function mostRecentOf(
  violations: StoredCspViolation[],
): StoredCspViolation | null {
  return violations.reduce<StoredCspViolation | null>(
    (latest, violation) =>
      latest === null || violation.receivedAt > latest.receivedAt
        ? violation
        : latest,
    null,
  );
}

type SummaryCompleteness = {
  totalListed: number;
  fetchFailures: number;
  invalidEntries: number;
};

function summarizeRollout(
  violations: StoredCspViolation[],
  { totalListed, fetchFailures, invalidEntries }: SummaryCompleteness,
): RolloutSignal {
  const matches = violations.filter((violation) =>
    isRolloutDirective(violation.effectiveDirective),
  );
  return {
    directive: ROLLOUT_DIRECTIVE,
    count: matches.length,
    mostRecent: mostRecentOf(matches),
    // Fails closed on two distinct kinds of missing evidence: a violation
    // hidden behind a failed fetch or an unparsed/corrupted blob might have
    // been script-src (fetchFailures/invalidEntries), and an empty store
    // (totalListed === 0) is exactly what the collector silently breaking
    // (a 500 from /csp-report, a mistyped report-uri, an over-eager prune)
    // would also look like — indistinguishable from a genuinely finished
    // rollout without this check. This signal is what the README says
    // authorizes dropping 'unsafe-inline' from the enforcing script-src, so
    // a false "stopped" here would weaken a live security header on bad
    // evidence.
    stopped:
      totalListed > 0 &&
      matches.length === 0 &&
      fetchFailures === 0 &&
      invalidEntries === 0,
  };
}

// Every get() runs concurrently within a batch, but batches run one at a
// time rather than firing all of them at once: the store's size is bounded
// only by retention (up to CSP_REPORT_MAX_BLOBS, 5000 by default — see
// cspReportPruner.ts), so an unbounded fan-out would open that many
// simultaneous Blobs requests, the exact shape that trips rate limits or
// starves sockets — undermining the scheduled adapter's own hard timeout by
// making a timeout more likely, not less. Exported so tests assert the real
// batch boundary instead of mirroring a magic number (mirrors
// DELETE_BATCH_SIZE in cspReportPruner.ts).
export const FETCH_BATCH_SIZE = 25;

async function fetchAll(
  client: BlobSummaryClient,
  keys: string[],
): Promise<FetchOutcome[]> {
  const outcomes: FetchOutcome[] = [];
  for (let start = 0; start < keys.length; start += FETCH_BATCH_SIZE) {
    const batch = keys.slice(start, start + FETCH_BATCH_SIZE);
    outcomes.push(
      ...(await Promise.all(batch.map((key) => fetchOne(client, key)))),
    );
  }
  return outcomes;
}

// Pure factory: given anything that can list and get blobs, returns a tool
// that reads every stored violation and aggregates it. It has no
// cooperative time budget of its own (unlike the pruner's list/delete
// passes) — the scheduled adapter (../csp-report-summary.ts) wraps the
// whole call in a hard timeout instead, so a store too large to summarize
// in time aborts the run rather than silently returning partial counts.
export function createCspReportSummary(
  client: BlobSummaryClient,
): CspReportSummaryTool {
  return {
    async summarize() {
      const keys = await listAllKeys(client);
      const outcomes = await fetchAll(client, keys);
      for (const outcome of outcomes) {
        logFetchOutcome(outcome);
      }
      const violations = outcomes
        .filter(isOk)
        .map((outcome) => outcome.violation);
      const fetchFailures = countStatus(outcomes, "failed");
      const invalidEntries = countStatus(outcomes, "invalid");
      return {
        totalListed: keys.length,
        totalViolations: violations.length,
        byDirective: aggregateByDirective(violations),
        byBlockedUri: aggregateByBlockedUri(violations),
        rollout: summarizeRollout(violations, {
          totalListed: keys.length,
          fetchFailures,
          invalidEntries,
        }),
        fetchFailures,
        missingEntries: countStatus(outcomes, "missing"),
        invalidEntries,
      };
    },
  };
}

// The concrete adapter the scheduled Function (../csp-report-summary.ts)
// uses. Netlify auto-configures Blobs (siteID/token injected via env) for
// deployed Functions and `netlify dev`, so no new environment variables are
// required; `getStore` only throws if that context is missing, which the
// adapter catches and logs rather than crashing the run.
export function getCspReportSummary(): CspReportSummaryTool {
  return createCspReportSummary(getStore(CSP_REPORT_STORE_NAME));
}
