import { getCspReportPruner } from "./lib/cspReportPruner";
import { getPruneFailureNotifier } from "./lib/notifyPruneFailure";
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

// A short, separate budget for the GitHub notification call, bounded well
// under HARD_TIMEOUT_MS's remaining headroom: this only runs after prune()
// has already failed (possibly after consuming most of HARD_TIMEOUT_MS
// itself), so it must not be able to push the whole run past Netlify's real
// 30s scheduled-Function limit. A timeout here is caught and logged the same
// as any other notify failure — the next hourly run's own failure (if the
// issue persists) gets another chance to notify.
export const NOTIFY_TIMEOUT_MS = 5000;

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

// cspReportPruner's own list/delete budgets are cooperative: they check the
// clock between pages/batches, not during a single slow list() page or
// Promise.allSettled call, so a hung Blobs request could in principle push
// past those without either one noticing. This hard timeout is the backstop:
// it always wins the race against Netlify's real 30s scheduled-Function
// limit, so a hang still produces a logged csp-report-prune-failed marker
// instead of the run being silently killed with nothing written to the logs.
export const HARD_TIMEOUT_MS = 28000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Best-effort: a broken notifier (bad/missing PRUNE_FAILURE_GITHUB_TOKEN,
// GitHub API outage, hang past NOTIFY_TIMEOUT_MS) must not crash the handler
// or turn the real 500 (the prune failure this reports) into an unhandled
// exception — see NOTIFY_FAILED_LOG_PREFIX above. A single flat try/catch
// (no nested control flow inside the handler's own catch block).
async function notifyPruneFailureQuietly(
  pruneErrorMessage: string,
): Promise<void> {
  try {
    await withTimeout(
      getPruneFailureNotifier().notify(pruneErrorMessage),
      NOTIFY_TIMEOUT_MS,
      "csp report prune failure notify",
    );
  } catch (notifyError) {
    console.warn(
      NOTIFY_FAILED_LOG_PREFIX,
      JSON.stringify({ message: errorMessage(notifyError) }),
    );
  }
}

export default async (_request: Request): Promise<Response> => {
  try {
    const result = await withTimeout(
      getCspReportPruner().prune(),
      HARD_TIMEOUT_MS,
      "csp report prune run",
    );
    console.log(PRUNED_LOG_PREFIX, JSON.stringify(result));
    return new Response(null, { status: HTTP_OK });
  } catch (error) {
    const message = errorMessage(error);
    console.warn(PRUNE_FAILED_LOG_PREFIX, JSON.stringify({ message }));
    await notifyPruneFailureQuietly(message);
    return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
  }
};

export const config = { schedule: "@hourly" };
