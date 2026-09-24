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

import {
  CSP_REPORT_STORE_NAME,
  ROLLOUT_DIRECTIVE,
  isRolloutDirective,
} from "./cspReportStore";
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
  // listComplete && fetchComplete — real data either way, never zeroed out.
  // Folded into summarizeRollout's fail-closed gate the same as
  // fetchFailures/missingEntries/invalidEntries: a key the run never got to
  // can hide a script-src violation just as easily as a failed one.
  complete: boolean;
  // False when listAllKeys was cut short by LIST_TIME_BUDGET_MS (totalListed
  // is then a lower bound, same caveat cspReportPruner.ts's own partial
  // listing carries).
  listComplete: boolean;
  // False when fetchAll was cut short by SUMMARY_TIME_BUDGET_MS before
  // attempting every key listAllKeys handed it.
  fetchComplete: boolean;
  // Every key this run committed to from list() — a page pulled past the
  // list deadline purely as a completeness probe (see listAllKeys) is
  // discarded rather than kept, so it is not counted here even though
  // list() did return it.
  totalListed: number;
  // Keys fetchAll actually attempted — the real denominator for
  // fetchFailures/missingEntries/invalidEntries/totalViolations below. Can
  // equal totalListed even when `complete` is false (a cut-short *list*
  // pass still gets every key it did find fully fetched) — check `complete`,
  // not this equality, to know the run was whole.
  totalFetched: number;
  totalViolations: number;
  // Descending by count (ties broken alphabetically for a deterministic
  // order), so the loudest directive/URI is first without the caller
  // re-sorting. Under sustained count-cap pressure, these two totals can
  // skew toward `script-src` (rollout-tagged) reports: the pruner's
  // count-cap pass now evicts non-rollout reports first (see overCapKeys in
  // cspReportPruner.ts and #135), so a flood or heavy organic traffic on a
  // non-script-src directive is more likely to be trimmed from the store
  // than script-src evidence is. That's the intended trade-off — it's what
  // protects `rollout` below, the signal this whole Function exists for —
  // but it means these two breakdowns are not a reliable total for
  // non-script-src directives during/after a flood, only `rollout` is.
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
  // than throwing) — most often the hourly pruner deleting it mid-walk.
  // Tracked separately from invalidEntries below and never logged (a key
  // vanishing between list and get isn't evidence of a corrupted blob), but
  // still folded into summarizeRollout's fail-closed gate below: the pruner
  // can still reach a rollout key (see byDirective/byBlockedUri above for
  // when/why), so a missing key can genuinely have been a recent violation
  // this run lost the race to read.
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

function isPastDeadline(deadlineMs: number): boolean {
  return Date.now() > deadlineMs;
}

type ListedKeys = { keys: string[]; complete: boolean };

const SUMMARY_LIST_FAILED_LOG_PREFIX = "csp-report-summary-list-failed";

// Wraps a single pages.next() call so a rejected list() page (Blobs outage
// mid-walk) degrades listAllKeys to a partial, fail-closed result instead of
// throwing the whole run away — the same "count it, don't crash" contract
// fetchOne already gives get() failures below.
async function pullPage(
  pages: AsyncIterator<BlobPage>,
): Promise<IteratorResult<BlobPage> | null> {
  try {
    return await pages.next();
  } catch (reason) {
    console.warn(
      SUMMARY_LIST_FAILED_LOG_PREFIX,
      JSON.stringify({ message: reasonMessage(reason) }),
    );
    return null;
  }
}

// Budgeted the same way cspReportPruner.ts's own listAllKeys is (see
// LIST_TIME_BUDGET_MS), but pulls pages manually instead of `for await`:
// checking the deadline immediately upon appending a page can't tell "more
// to list" from "that was the last page and it merely arrived late", which
// would misreport `complete: false` on a fully-listed store — a false
// negative on the signal that gates `rollout.stopped`. Once the deadline
// has passed, exactly one further page is pulled as a probe: a `done`
// result there proves the page just appended really was the last one, so
// `complete: true` is still reported; a real (non-`done`) result proves
// further, uncaptured data exists, so it is discarded rather than merged
// into `keys` — the run keeps only pages it fully committed to before the
// deadline, so `complete: false` always means real data was left out, never
// a store this run actually finished draining.
async function listAllKeys(
  client: BlobSummaryClient,
  deadlineMs: number,
): Promise<ListedKeys> {
  const keys: string[] = [];
  const pages = client.list({ paginate: true })[Symbol.asyncIterator]();
  for (;;) {
    const result = await pullPage(pages);
    if (result === null) {
      return { keys, complete: false };
    }
    if (result.done) {
      return { keys, complete: true };
    }
    keys.push(...result.value.blobs.map((blob) => blob.key));
    if (!isPastDeadline(deadlineMs)) {
      continue;
    }
    const lookahead = await pullPage(pages);
    if (lookahead === null) {
      return { keys, complete: false };
    }
    if (lookahead.done) {
      return { keys, complete: true };
    }
    await pages.return?.()?.catch(() => {});
    return { keys, complete: false };
  }
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
  fetchFailures: number;
  missingEntries: number;
  invalidEntries: number;
  // See the `complete` field on CspReportSummary — an incomplete fetchAll
  // run leaves some listed keys never attempted at all, which is exactly as
  // dangerous to a "stopped" verdict as a key that was attempted and failed.
  complete: boolean;
};

function summarizeRollout(
  violations: StoredCspViolation[],
  {
    fetchFailures,
    missingEntries,
    invalidEntries,
    complete,
  }: SummaryCompleteness,
): RolloutSignal {
  const matches = violations.filter((violation) =>
    isRolloutDirective(violation.effectiveDirective),
  );
  return {
    directive: ROLLOUT_DIRECTIVE,
    count: matches.length,
    mostRecent: mostRecentOf(matches),
    // Fails closed on every way a script-src violation could be sitting in
    // the store without this run having read it: a failed fetch or an
    // unparsed/corrupted blob (fetchFailures/invalidEntries), a key the
    // pruner evicted mid-walk (missingEntries — see that field's comment
    // above for when a rollout key can still be the one evicted), or a key
    // fetchAll never got to at all before its own time budget ran out
    // (complete: false). An unattempted key is no more evidence of "clean"
    // than a failed or missing one. This signal is what the README says
    // authorizes dropping 'unsafe-inline' from the enforcing script-src, so
    // a false "stopped" here would weaken a live security header on bad
    // evidence.
    //
    // Deliberately NOT gated on the store being non-empty: an empty store
    // that's read cleanly and completely (zero of every completeness
    // counter above, complete: true) is the designed end state of a
    // successful rollout, not evidence of anything wrong — treating it as
    // "can't tell" would make `stopped` permanently unreachable once the
    // rollout actually finishes and the 30-day retention window rolls the
    // last evidence off. A collector that stops receiving traffic entirely
    // (a 500 from /csp-report, a mistyped report-uri) is a distinct failure
    // mode already covered by its own signal (csp-report-persist-failed in
    // csp-report.ts), not this one's job to re-derive from store volume.
    stopped:
      matches.length === 0 &&
      fetchFailures === 0 &&
      missingEntries === 0 &&
      invalidEntries === 0 &&
      complete,
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

// The run's combined list+fetch budget (mirrors PRUNE_TIME_BUDGET_MS in
// cspReportPruner.ts), split in half so a slow list() walk can't starve
// fetchAll of its share. Kept 8000ms under the adapter's HARD_TIMEOUT_MS
// (../csp-report-summary.ts) — same gap as the pruner's own budget vs. its
// hard timeout — so whatever batch is in flight when this trips has real
// room to finish before the hard timeout would instead discard the whole
// run (margin asserted in cspReportSummaryFunction.test.ts).
export const SUMMARY_TIME_BUDGET_MS = 20000;
export const LIST_TIME_BUDGET_MS = Math.floor(SUMMARY_TIME_BUDGET_MS / 2);

type FetchAllResult = {
  outcomes: FetchOutcome[];
  // False when the deadline was reached before every key was attempted —
  // see SUMMARY_TIME_BUDGET_MS and the `fetchComplete` field on
  // CspReportSummary.
  complete: boolean;
};

// cspReportStore.ts's violationKey prefixes every key with a sanitized ISO
// receivedAt (see RECEIVED_AT_PREFIX_LENGTH there), so a plain descending
// string sort orders keys newest-first without parsing anything — the same
// property cspReportPruner.ts relies on for its own oldest-first sort
// (unsortedKeys.sort() in createCspReportPruner), just reversed. Netlify
// Blobs' list() order is not documented as sorted (the pruner sorts its own
// unsortedKeys rather than trusting it), so this is the only thing standing
// between a truncated fetchAll and reading whatever order list() happened
// to return.
function sortNewestFirst(keys: string[]): string[] {
  return [...keys].sort().reverse();
}

// Checks the deadline in the loop condition (mirrors deleteKeys in
// cspReportPruner.ts) so stopping early and finishing normally are the same
// exit, not two separate return points; checked once per batch boundary,
// not within a batch, since the concurrent Promise.all already in flight
// always finishes. Callers must pass keys newest-first (see
// sortNewestFirst): a fetch pass cut short by SUMMARY_TIME_BUDGET_MS must
// drop the oldest, least decision-relevant evidence, not whatever list()
// happened to return last — the rollout signal this whole module exists to
// produce is specifically about *recent* script-src activity.
async function fetchAll(
  client: BlobSummaryClient,
  keys: string[],
  deadlineMs: number,
): Promise<FetchAllResult> {
  const outcomes: FetchOutcome[] = [];
  let start = 0;
  while (start < keys.length && !isPastDeadline(deadlineMs)) {
    const batch = keys.slice(start, start + FETCH_BATCH_SIZE);
    outcomes.push(
      ...(await Promise.all(batch.map((key) => fetchOne(client, key)))),
    );
    start += batch.length;
  }
  return { outcomes, complete: start >= keys.length };
}

// Pure factory: given anything that can list and get blobs, returns a tool
// that reads every stored violation and aggregates it. The list and fetch
// passes each have their own cooperative time budget (see
// LIST_TIME_BUDGET_MS / SUMMARY_TIME_BUDGET_MS above), so a store too large
// to finish in one pass still returns a real, partial summary (complete:
// false) instead of being discarded wholesale; the scheduled adapter
// (../csp-report-summary.ts) still wraps the whole call in a hard timeout
// as a backstop for a genuine hang that neither cooperative check would
// catch.
export function createCspReportSummary(
  client: BlobSummaryClient,
): CspReportSummaryTool {
  return {
    async summarize() {
      const startMs = Date.now();
      const listDeadlineMs = startMs + LIST_TIME_BUDGET_MS;
      const fetchDeadlineMs = startMs + SUMMARY_TIME_BUDGET_MS;
      const { keys, complete: listComplete } = await listAllKeys(
        client,
        listDeadlineMs,
      );
      const { outcomes, complete: fetchComplete } = await fetchAll(
        client,
        sortNewestFirst(keys),
        fetchDeadlineMs,
      );
      const complete = listComplete && fetchComplete;
      for (const outcome of outcomes) {
        logFetchOutcome(outcome);
      }
      const violations = outcomes
        .filter(isOk)
        .map((outcome) => outcome.violation);
      const fetchFailures = countStatus(outcomes, "failed");
      const missingEntries = countStatus(outcomes, "missing");
      const invalidEntries = countStatus(outcomes, "invalid");
      return {
        complete,
        listComplete,
        fetchComplete,
        totalListed: keys.length,
        totalFetched: outcomes.length,
        totalViolations: violations.length,
        byDirective: aggregateByDirective(violations),
        byBlockedUri: aggregateByBlockedUri(violations),
        rollout: summarizeRollout(violations, {
          fetchFailures,
          missingEntries,
          invalidEntries,
          complete,
        }),
        fetchFailures,
        missingEntries,
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
