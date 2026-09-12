import { getCspReportPruner } from "./lib/cspReportPruner";
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
    console.warn(
      PRUNE_FAILED_LOG_PREFIX,
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
  }
};

export const config = { schedule: "@hourly" };
