import { errorMessage } from "./lib/errorMessage";
import { getCspReportPruner } from "./lib/cspReportPruner";
import {
  NOTIFY_TIMEOUT_MS,
  RUN_DEADLINE_MS,
  runWithinNotifyBudget,
} from "./lib/notifyBudget";
import {
  getPruneFailureNotifier,
  getPruneFailureResolver,
} from "./lib/notifyPruneFailure";
import { withTimeout } from "./lib/withTimeout";

// Netlify scheduled Function (v2) that prunes the csp-reports Blobs store on
// an hourly cadence. csp-report.ts rate-limits per caller at write time, but
// that alone doesn't bound the store's total size (a distributed flood
// bypasses a per-IP limit, and even organic traffic accumulates over time);
// this Function is what actually keeps the store bounded. The retention/cap
// strategy itself lives in cspReportPruner.ts, this adapter only invokes it
// on a schedule and reports the outcome to the function logs. Hourly (rather
// than daily) keeps each run's backlog small enough to reliably finish
// inside cspReportPruner's own time budget — see PRUNE_TIME_BUDGET_MS.

const PRUNED_LOG_PREFIX = "csp-report-pruned";
// Logged when the prune run itself fails (Blobs outage, missing context,
// hard timeout, etc.). Distinct from PERSIST_FAILED_LOG_PREFIX in
// csp-report.ts — this is the maintenance path, not a rejected report — so
// the two failure modes don't get conflated when grepping the logs.
const PRUNE_FAILED_LOG_PREFIX = "csp-report-prune-failed";
// Logged when the failure-notification path itself breaks (missing/invalid
// PRUNE_FAILURE_GITHUB_TOKEN, GitHub API outage, etc.). This must never
// crash the handler or change its response — the underlying prune failure
// (PRUNE_FAILED_LOG_PREFIX, logged above it) is the real signal, and is
// already written by the time this can fail. See #123.
const NOTIFY_FAILED_LOG_PREFIX = "csp-report-prune-notify-failed";

// Logged when closing a resolved prune-failure issue breaks (missing token,
// GitHub outage, timeout). Like NOTIFY_FAILED_LOG_PREFIX, this must never
// change the response: the prune itself already succeeded. See #163.
const RESOLVE_FAILED_LOG_PREFIX = "csp-report-prune-resolve-failed";

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

// Netlify scheduled Functions have a hard 30s execution limit. The prune
// budget and the notify budget are sequential, not independent (notify only
// ever runs after prune() has already failed), so they share one combined
// ceiling, RUN_DEADLINE_MS, defined with the notify budget in
// lib/notifyBudget.ts. HARD_TIMEOUT_MS below is what is left for prune() once
// NOTIFY_TIMEOUT_MS is reserved for the notify call that might follow it.
// cspReportPruneFunction.test.ts pins the full ordering invariant:
// cspReportPruner's own PRUNE_TIME_BUDGET_MS < HARD_TIMEOUT_MS <
// RUN_DEADLINE_MS, so a normal partial run (store too large to finish in one
// pass) exits gracefully via PRUNE_TIME_BUDGET_MS well before HARD_TIMEOUT_MS
// would kill it and report it as a failure.

// cspReportPruner's own list/delete budgets are cooperative: they check the
// clock between pages/batches, not during a single slow list() page or
// Promise.allSettled call, so a hung Blobs request could in principle push
// past those without either one noticing. This hard timeout is the backstop:
// it always wins the race against Netlify's real 30s scheduled-Function
// limit (even after reserving NOTIFY_TIMEOUT_MS for the notify call that
// follows a failure), so a hang still produces a logged
// csp-report-prune-failed marker instead of the run being silently killed
// with nothing written to the logs. Because RESPONSE_HEADROOM_MS is also
// kept free, a notify after a full hang gets slightly under
// NOTIFY_TIMEOUT_MS (see remainingNotifyBudgetMs).
export const HARD_TIMEOUT_MS = RUN_DEADLINE_MS - NOTIFY_TIMEOUT_MS;

// Best-effort: a broken notifier (bad/missing PRUNE_FAILURE_GITHUB_TOKEN,
// GitHub API outage, hang past the remaining notify budget) must not crash the handler
// or turn the real 500 (the prune failure this reports) into an unhandled
// exception — see NOTIFY_FAILED_LOG_PREFIX above. A single flat try/catch
// (no nested control flow inside the handler's own catch block).
async function notifyPruneFailureQuietly(
  pruneErrorMessage: string,
  runStartedAt: number,
): Promise<void> {
  await runWithinNotifyBudget(
    runStartedAt,
    NOTIFY_FAILED_LOG_PREFIX,
    "csp report prune failure notify",
    () => getPruneFailureNotifier().notify(pruneErrorMessage),
  );
}

// Best-effort, same contract as notifyPruneFailureQuietly: a successful
// prune run must never fail because the issue closer broke. Shares the
// notify budget since it also runs after prune() has used up to
// HARD_TIMEOUT_MS, and must stay within RUN_DEADLINE_MS.
async function resolvePruneFailureQuietly(runStartedAt: number): Promise<void> {
  await runWithinNotifyBudget(
    runStartedAt,
    RESOLVE_FAILED_LOG_PREFIX,
    "csp report prune failure resolve",
    () => getPruneFailureResolver().resolve(),
  );
}

export default async (_request: Request): Promise<Response> => {
  const runStartedAt = Date.now();
  try {
    const result = await withTimeout(
      getCspReportPruner().prune(),
      HARD_TIMEOUT_MS,
      "csp report prune run",
    );
    console.log(PRUNED_LOG_PREFIX, JSON.stringify(result));
  } catch (error) {
    const message = errorMessage(error);
    console.warn(PRUNE_FAILED_LOG_PREFIX, JSON.stringify({ message }));
    await notifyPruneFailureQuietly(message, runStartedAt);
    return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
  }
  await resolvePruneFailureQuietly(runStartedAt);
  return new Response(null, { status: HTTP_OK });
};

export const config = { schedule: "@hourly" };
