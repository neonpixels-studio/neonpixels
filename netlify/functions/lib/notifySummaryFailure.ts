// GitHub issue notifier for a failed csp-report-summary run. Equivalent to
// notifyPruneFailure.ts for csp-report-prune (see issue #123) — csp-report-summary
// is the only other durable signal read off the csp-reports store (the
// script-src rollout check), and until now had no failure notifier at all:
// a silently-broken summary run meant nobody would ever be told the rollout
// signal had gone stale — see issue #137. Built on the same
// githubFailureNotifier.ts seam as the prune notifier (fetch adapter, error
// redaction, re-notify throttling), so this file supplies only what's
// specific to a summary failure: the label/title/marker/body. Isolated
// behind the same GithubIssuesClient seam cspReportStore.ts uses for Blobs
// writes (BlobWriter) and cspReportSummary.ts uses for list/get
// (BlobSummaryClient), so the duplicate-guard logic is unit-tested against a
// fake client instead of the real GitHub API.

import {
  createFailureNotifier,
  createFetchGithubIssuesClient,
  sanitizeReportedError,
  type FailureNotifier,
  type GithubIssuesClient,
} from "./githubFailureNotifier";

export { sanitizeReportedError };
export type {
  GithubIssueOrPullRequest,
  GithubIssuesClient,
} from "./githubFailureNotifier";

// Named like the other log markers in this feature
// (SUMMARY_FAILED_LOG_PREFIX etc. in csp-report-summary.ts) rather than an
// inline literal, and exported so notifySummaryFailure.test.ts can assert
// against it directly.
export const NOTIFY_THROTTLED_LOG_PREFIX =
  "csp-report-summary-notify-throttled";

export const SUMMARY_FAILURE_LABEL = "csp-summary-failure";
export const SUMMARY_FAILURE_ISSUE_TITLE =
  "Scheduled csp-report-summary Function failed";

// Invisible in rendered Markdown, and written into the issue body rather
// than the title, for the same reason notify-audit-failure.cjs (and
// notifyPruneFailure.ts) do this: a title is fair game for a human to edit
// during triage, which would break a title-based match on the next failure;
// the body marker survives that.
export const SUMMARY_FAILURE_ISSUE_MARKER =
  "<!-- neonpixels:summary-failure-notifier -->";

function buildIssueBody(errorMessage: string): string {
  return [
    SUMMARY_FAILURE_ISSUE_MARKER,
    "The daily csp-report-summary scheduled Function failed.",
    "",
    `Error: ${sanitizeReportedError(errorMessage)}`,
    "",
    "Check the Netlify Function logs for the full `csp-report-summary-failed` entry.",
    "This issue is a duplicate guard: closing it lets the next failure open a new one.",
  ].join("\n");
}

export type SummaryFailureNotifier = FailureNotifier;

// Pure factory: given anything that can list/create/comment on GitHub
// issues, returns a notifier with the same one-open-issue-per-failure-streak
// behavior as the prune notifier (via createFailureNotifier).
export function createSummaryFailureNotifier(
  client: GithubIssuesClient,
): SummaryFailureNotifier {
  return createFailureNotifier(client, {
    trackingLabel: SUMMARY_FAILURE_LABEL,
    issueTitle: SUMMARY_FAILURE_ISSUE_TITLE,
    issueMarker: SUMMARY_FAILURE_ISSUE_MARKER,
    throttledLogPrefix: NOTIFY_THROTTLED_LOG_PREFIX,
    buildIssueBody,
    // The summary run is daily — already sparser than any re-notify window
    // worth setting, so every failed run comments/creates rather than
    // risking a human's unrelated issue touch silencing a whole day's
    // failure for no throttling benefit (see RENOTIFY_INTERVAL_MS in
    // githubFailureNotifier.ts).
    renotifyIntervalMs: 0,
  });
}

export function getSummaryFailureNotifier(): SummaryFailureNotifier {
  return createSummaryFailureNotifier(createFetchGithubIssuesClient());
}
