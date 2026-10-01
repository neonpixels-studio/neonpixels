import {
  getCspReportSummary,
  type CspReportSummary,
} from "./lib/cspReportSummary";
import { errorMessage } from "./lib/errorMessage";
import { getSummaryFailureNotifier } from "./lib/notifySummaryFailure";
import { withTimeout } from "./lib/withTimeout";

// Netlify scheduled Function (v2) that reads and aggregates the csp-reports
// Blobs store daily. cspReportStore.ts only writes, and csp-report-prune.ts
// only lists keys to delete them — neither answers the question the store
// exists for: which directives/blocked URIs are still firing, and
// specifically whether the script-src rollout (see the `@todo` in
// netlify.toml) has actually stopped. Before this, that could only be
// checked by grepping raw per-violation log lines (see csp-violation in
// csp-report.ts) rather than reading the durable, structured copy.
//
// Scheduled rather than a public route: the aggregation strategy itself
// lives in lib/cspReportSummary.ts, this adapter only invokes it on a
// schedule and reports the outcome to the function logs. Scheduled
// Functions aren't reachable over the public internet the way a routed
// Function is (the same property csp-report-prune.ts already relies on to
// run its list/delete pass unauthenticated) — required here because the
// summary's `mostRecent` violation embeds attacker-influenced fields
// (blockedUri, sourceFile, sample) that must not be exposed at a public,
// unauthenticated endpoint. It's also invokable on demand via
// `netlify functions:invoke csp-report-summary` against a linked site for an
// ad-hoc rollout check, without waiting for the schedule. Daily (rather than
// hourly, like the pruner) is frequent enough for a rollout signal that
// changes on the order of days/weeks, without paying to walk the whole store
// every hour.

// The decision-relevant fields (rollout signal + totals), logged first and
// on their own line so they're never at risk of truncation from a large
// breakdown line (see SUMMARY_BREAKDOWN_LOG_PREFIX below) — this is the
// output the whole Function exists to produce.
const SUMMARIZED_LOG_PREFIX = "csp-report-summarized";
// The byDirective/byBlockedUri breakdowns, logged separately and capped
// (see BREAKDOWN_TOP_N): blockedUri is attacker-influenced free text coming
// through a public, unauthenticated endpoint (see csp-report.ts), so a
// flood of distinct blocked URIs up to CSP_REPORT_MAX_BLOBS (5000 by
// default — see cspReportPruner.ts) would otherwise put an unbounded,
// hundreds-of-KB array on one log line.
const SUMMARY_BREAKDOWN_LOG_PREFIX = "csp-report-summary-breakdown";
// Logged when the summary run itself fails (Blobs outage, missing context,
// hard timeout, etc.). Distinct from PERSIST_FAILED_LOG_PREFIX in
// csp-report.ts and PRUNE_FAILED_LOG_PREFIX in csp-report-prune.ts — this is
// the read/aggregation path, not a write or a delete — so the three failure
// modes don't get conflated when grepping the logs.
const SUMMARY_FAILED_LOG_PREFIX = "csp-report-summary-failed";
// Logged, in addition to the two lines above, when the run itself succeeded
// but hit its own time budget partway through (summary.complete === false —
// see LIST_TIME_BUDGET_MS/SUMMARY_TIME_BUDGET_MS in lib/cspReportSummary.ts).
// Distinct from SUMMARY_FAILED_LOG_PREFIX: this run still returns a 200 and
// real (if partial) counts, but a store consistently too large to finish in
// one run needs its own greppable, alertable signal — unlike the hourly
// pruner, an oversized store here has no self-correcting next run that
// would otherwise surface the problem on its own. Carries listComplete/
// fetchComplete (not just the combined `complete`) so the alert points at
// which pass ran out — a truncated list pass calls for a different fix
// (pagination, page size) than a truncated fetch pass (FETCH_BATCH_SIZE,
// store size).
const SUMMARY_INCOMPLETE_LOG_PREFIX = "csp-report-summary-incomplete";
// Logged when the failure-notification path itself breaks (missing/invalid
// PRUNE_FAILURE_GITHUB_TOKEN, GitHub API outage, etc.). This must never
// crash the handler or change its response — the underlying summary failure
// (SUMMARY_FAILED_LOG_PREFIX, logged above it) is the real signal, and is
// already written by the time this can fail. Mirrors
// NOTIFY_FAILED_LOG_PREFIX in csp-report-prune.ts — see #123, #137.
const NOTIFY_FAILED_LOG_PREFIX = "csp-report-summary-notify-failed";

// Enough to see the loudest offenders without risking the same unbounded-line
// problem the breakdowns are split out to avoid; the full counts are still
// derivable by summing (see totalViolations) even when truncated.
const BREAKDOWN_TOP_N = 20;

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

// Separate from logSummary below so the two responsibilities (deciding
// whether to raise the incomplete-run alarm, vs. always logging the
// outcome) read as their own sentences rather than one function doing both.
function warnIfIncomplete(summary: CspReportSummary): void {
  if (summary.complete) {
    return;
  }
  console.warn(
    SUMMARY_INCOMPLETE_LOG_PREFIX,
    JSON.stringify({
      listComplete: summary.listComplete,
      fetchComplete: summary.fetchComplete,
      totalListed: summary.totalListed,
      totalFetched: summary.totalFetched,
    }),
  );
}

function logSummary(summary: CspReportSummary): void {
  console.log(
    SUMMARIZED_LOG_PREFIX,
    JSON.stringify({
      rollout: summary.rollout,
      complete: summary.complete,
      totalListed: summary.totalListed,
      totalFetched: summary.totalFetched,
      totalViolations: summary.totalViolations,
      fetchFailures: summary.fetchFailures,
      missingEntries: summary.missingEntries,
      invalidEntries: summary.invalidEntries,
    }),
  );
  console.log(
    SUMMARY_BREAKDOWN_LOG_PREFIX,
    JSON.stringify({
      byDirective: summary.byDirective.slice(0, BREAKDOWN_TOP_N),
      byBlockedUri: summary.byBlockedUri.slice(0, BREAKDOWN_TOP_N),
    }),
  );
}

// Netlify scheduled Functions have a hard 30s execution limit.
// RUN_DEADLINE_MS is the ceiling for summarize() (2s headroom for cold start
// and the final in-flight batch). It is deliberately NOT reduced by the
// notify budget: that budget is only needed after a failure, so reserving it
// up front taxed every successful run. Instead the notify budget is computed
// cooperatively from the time actually left (see remainingNotifyBudgetMs).
export const RUN_DEADLINE_MS = 28000;

// Netlify's real scheduled-Function execution limit.
export const NETLIFY_FUNCTION_LIMIT_MS = 30000;

// Kept free after notify so the 500 response can still be returned before
// Netlify kills the run.
export const RESPONSE_HEADROOM_MS = 500;

// Upper bound for the GitHub notification call, which only runs after
// summarize() has already failed. The budget actually used is the smaller of
// this and whatever is left of the real limit, so a fast failure (e.g. a
// Blobs outage) gets the full amount while a late hang gets the remainder.
// A timeout here is caught and logged the same as any other notify failure.
export const NOTIFY_TIMEOUT_MS = 5000;

// cspReportSummary's own list/fetch passes have cooperative time budgets
// (see LIST_TIME_BUDGET_MS / SUMMARY_TIME_BUDGET_MS in
// lib/cspReportSummary.ts for the full ordering invariant against this
// constant) that return a real, partial summary (complete: false) rather
// than nothing once a store is too large to finish in one run, but those
// checks only happen between pages/batches, so a single hung get() or
// list() page could still run past them unnoticed. This hard timeout is the
// backstop for exactly that case (mirrors HARD_TIMEOUT_MS in
// csp-report-prune.ts): it always wins the race against Netlify's real 30s
// limit, so a genuine hang still produces a logged csp-report-summary-failed
// marker instead of the run being silently killed.
export const HARD_TIMEOUT_MS = RUN_DEADLINE_MS;

export function remainingNotifyBudgetMs(elapsedMs: number): number {
  const remaining =
    NETLIFY_FUNCTION_LIMIT_MS - elapsedMs - RESPONSE_HEADROOM_MS;
  return Math.max(0, Math.min(NOTIFY_TIMEOUT_MS, remaining));
}

// Best-effort: a broken notifier (bad/missing PRUNE_FAILURE_GITHUB_TOKEN,
// GitHub API outage, hang past NOTIFY_TIMEOUT_MS) must not crash the handler
// or turn the real 500 (the summary failure this reports) into an unhandled
// exception — see NOTIFY_FAILED_LOG_PREFIX above. A single flat try/catch
// (no nested control flow inside the handler's own catch block), mirroring
// notifyPruneFailureQuietly in csp-report-prune.ts.
async function notifySummaryFailureQuietly(
  summaryErrorMessage: string,
  runStartedAt: number,
): Promise<void> {
  try {
    await withTimeout(
      getSummaryFailureNotifier().notify(summaryErrorMessage),
      remainingNotifyBudgetMs(Date.now() - runStartedAt),
      "csp report summary failure notify",
    );
  } catch (notifyError) {
    console.warn(
      NOTIFY_FAILED_LOG_PREFIX,
      JSON.stringify({ message: errorMessage(notifyError) }),
    );
  }
}

export default async (_request: Request): Promise<Response> => {
  const runStartedAt = Date.now();
  try {
    const summary = await withTimeout(
      getCspReportSummary().summarize(),
      HARD_TIMEOUT_MS,
      "csp report summary run",
    );
    warnIfIncomplete(summary);
    logSummary(summary);
    return new Response(null, { status: HTTP_OK });
  } catch (error) {
    const message = errorMessage(error);
    console.warn(SUMMARY_FAILED_LOG_PREFIX, JSON.stringify({ message }));
    await notifySummaryFailureQuietly(message, runStartedAt);
    return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
  }
};

export const config = { schedule: "@daily" };
