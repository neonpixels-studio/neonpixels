import { errorMessage } from "./errorMessage";
import { withTimeout } from "./withTimeout";

// Time budget shared by the scheduled Functions that notify GitHub after a
// failed run (csp-report-prune.ts, csp-report-summary.ts). Both run under the
// same Netlify limit and both notify only after the main work has already
// failed, so the notify call must fit in whatever is left of one combined
// deadline rather than assuming the full window. See #175.

// Netlify's real scheduled-Function execution limit.
export const NETLIFY_FUNCTION_LIMIT_MS = 30000;

// Cold start and module load happen before the handler's own clock starts,
// so they are carved out of the limit rather than measured.
export const COLD_START_HEADROOM_MS = 2000;

// The combined ceiling for the whole run (main work + any failure notify).
export const RUN_DEADLINE_MS =
  NETLIFY_FUNCTION_LIMIT_MS - COLD_START_HEADROOM_MS;

// Kept free after notify so the 500 response can still be returned.
export const RESPONSE_HEADROOM_MS = 500;

// Upper bound for the GitHub notification call. The budget actually used is
// the smaller of this and what is left of RUN_DEADLINE_MS (see
// remainingNotifyBudgetMs), so a fast failure (e.g. a Blobs outage) gets the
// full amount. A timeout is caught and logged like any other notify failure.
export const NOTIFY_TIMEOUT_MS = 5000;

export function remainingNotifyBudgetMs(elapsedMs: number): number {
  const remaining = RUN_DEADLINE_MS - elapsedMs;
  return Math.max(
    0,
    Math.min(NOTIFY_TIMEOUT_MS, remaining - RESPONSE_HEADROOM_MS),
  );
}

export const NO_TIME_LEFT_MESSAGE = "no time left in run budget";

// Runs a best-effort GitHub call (failure notify or resolve) inside whatever
// is left of the run budget. Never throws: a skipped or failed call is logged
// under `failedLogPrefix` so it can't change the handler's response. `call`
// is a thunk so nothing is constructed when the budget is already gone.
export async function runWithinNotifyBudget(
  runStartedAt: number,
  failedLogPrefix: string,
  label: string,
  call: () => Promise<unknown>,
): Promise<void> {
  const budgetMs = remainingNotifyBudgetMs(Date.now() - runStartedAt);
  if (budgetMs <= 0) {
    console.warn(
      failedLogPrefix,
      JSON.stringify({ message: NO_TIME_LEFT_MESSAGE }),
    );
    return;
  }
  try {
    await withTimeout(call(), budgetMs, label);
  } catch (error) {
    console.warn(
      failedLogPrefix,
      JSON.stringify({ message: errorMessage(error) }),
    );
  }
}
