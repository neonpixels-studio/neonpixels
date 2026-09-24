// A caught value in a `catch` block isn't guaranteed to be an `Error` (a
// thrown string/object surfaces the same way), so every caller that wants a
// loggable/reportable message needs this same narrowing. Shared here once
// three independent call sites converged on the identical shape:
// csp-report-prune.ts's and csp-report-summary.ts's own handler-catches, and
// the label-attach retry in githubFailureNotifier.ts.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
