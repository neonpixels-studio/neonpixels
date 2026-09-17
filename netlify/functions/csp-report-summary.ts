import { getCspReportSummary } from "./lib/cspReportSummary";
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

const SUMMARIZED_LOG_PREFIX = "csp-report-summarized";
// Logged when the summary run itself fails (Blobs outage, missing context,
// hard timeout, etc.). Distinct from PERSIST_FAILED_LOG_PREFIX in
// csp-report.ts and PRUNE_FAILED_LOG_PREFIX in csp-report-prune.ts — this is
// the read/aggregation path, not a write or a delete — so the three failure
// modes don't get conflated when grepping the logs.
const SUMMARY_FAILED_LOG_PREFIX = "csp-report-summary-failed";

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

// cspReportSummary has no cooperative time budget of its own — a run's cost
// scales with store size the same way pruning's does, but summarizing does a
// get() per key on top of the list pass, so a large store is more likely to
// run long. This hard timeout is the backstop (mirrors HARD_TIMEOUT_MS in
// csp-report-prune.ts): it always wins the race against Netlify's real 30s
// scheduled-Function limit, so a hang still produces a logged
// csp-report-summary-failed marker instead of the run being silently killed
// with nothing written to the logs.
export const HARD_TIMEOUT_MS = 28000;

export default async (_request: Request): Promise<Response> => {
  try {
    const summary = await withTimeout(
      getCspReportSummary().summarize(),
      HARD_TIMEOUT_MS,
      "csp report summary run",
    );
    console.log(SUMMARIZED_LOG_PREFIX, JSON.stringify(summary));
    return new Response(null, { status: HTTP_OK });
  } catch (error) {
    console.warn(
      SUMMARY_FAILED_LOG_PREFIX,
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(null, { status: HTTP_INTERNAL_SERVER_ERROR });
  }
};

export const config = { schedule: "@daily" };
