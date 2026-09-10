import { getCspReportPruner } from "./lib/cspReportPruner";

// Netlify scheduled Function (v2) that prunes the csp-reports Blobs store on
// an hourly cadence. The public, unauthenticated /csp-report endpoint
// (csp-report.ts) has no per-caller rate limit, so without this the store
// could grow without bound under sustained abuse; the retention/cap strategy
// itself lives in cspReportPruner.ts, this adapter only invokes it on a
// schedule and reports the outcome to the function logs. Hourly (rather than
// daily) keeps each run's backlog small enough to reliably finish inside
// cspReportPruner's own time budget — see PRUNE_TIME_BUDGET_MS.

const PRUNED_LOG_PREFIX = "csp-report-pruned";
// Logged when the prune run itself fails (Blobs outage, missing context,
// etc.). Distinct from PERSIST_FAILED_LOG_PREFIX in csp-report.ts — this is
// the maintenance path, not a rejected report — so the two failure modes
// don't get conflated when grepping the logs.
const PRUNE_FAILED_LOG_PREFIX = "csp-report-prune-failed";

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

export default async (_request: Request): Promise<Response> => {
  try {
    const result = await getCspReportPruner().prune();
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
