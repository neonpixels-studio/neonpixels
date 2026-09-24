// GitHub issue notifier for a failed csp-report-prune run. Mirrors the
// duplicate-guard behavior in .github/scripts/notify-audit-failure.cjs (find
// an open, marker-tagged issue and comment on it; otherwise open a new one)
// so a failing prune run is surfaced the same way a failing scheduled audit
// run already is — see issue #123. That script authenticates via
// actions/github-script's built-in Octokit client, which only exists inside
// a GitHub Actions job; this module runs inside a Netlify Function instead,
// where no such client is available, so it talks to the GitHub REST API
// directly over `fetch`. The two aren't shared code (one is CommonJS loaded
// by actions/github-script, the other TypeScript bundled into the Netlify
// Function), but they deliberately encode the same duplicate-guard shape —
// label + body-marker match, comment on an existing tracked issue instead of
// opening a duplicate — so a human who has read one recognizes the other.
//
// The generic list/comment/create mechanics (fetch adapter, error
// redaction, re-notify throttling) live in githubFailureNotifier.ts, shared
// with notifySummaryFailure.ts's equivalent for csp-report-summary (see
// issue #137) — this file supplies only what's specific to a prune failure:
// the label/title/marker/body. Isolated behind the same GithubIssuesClient
// seam cspReportStore.ts uses for Blobs writes (BlobWriter) and
// cspReportPruner.ts uses for list/delete (BlobPrunerClient), so the
// duplicate-guard logic is unit-tested against a fake client instead of the
// real GitHub API.

import {
  createFailureNotifier,
  createFetchGithubIssuesClient,
  sanitizeReportedError,
  RENOTIFY_INTERVAL_MS,
  type FailureNotifier,
  type GithubIssuesClient,
} from "./githubFailureNotifier";

// Named like the other log markers in this feature (PRUNE_FAILED_LOG_PREFIX
// etc. in csp-report-prune.ts) rather than an inline literal, and exported
// so notifyPruneFailure.test.ts can assert against it directly.
export const NOTIFY_THROTTLED_LOG_PREFIX = "csp-report-prune-notify-throttled";

export const PRUNE_FAILURE_LABEL = "csp-prune-failure";
export const PRUNE_FAILURE_ISSUE_TITLE =
  "Scheduled csp-report-prune Function failed";

// Invisible in rendered Markdown, and written into the issue body rather
// than the title, for the same reason notify-audit-failure.cjs does this: a
// title is fair game for a human to edit during triage, which would break a
// title-based match on the next failure; the body marker survives that.
export const PRUNE_FAILURE_ISSUE_MARKER =
  "<!-- neonpixels:prune-failure-notifier -->";

function buildIssueBody(errorMessage: string): string {
  return [
    PRUNE_FAILURE_ISSUE_MARKER,
    "The hourly csp-report-prune scheduled Function failed.",
    "",
    `Error: ${sanitizeReportedError(errorMessage)}`,
    "",
    "Check the Netlify Function logs for the full `csp-report-prune-failed` entry.",
    "This issue is a duplicate guard: closing it lets the next failure open a new one.",
  ].join("\n");
}

export type PruneFailureNotifier = FailureNotifier;

// Pure factory: given anything that can list/create/comment on GitHub
// issues, returns a notifier with the same one-open-issue-per-failure-streak
// behavior as notify-audit-failure.cjs (via createFailureNotifier).
export function createPruneFailureNotifier(
  client: GithubIssuesClient,
): PruneFailureNotifier {
  return createFailureNotifier(client, {
    trackingLabel: PRUNE_FAILURE_LABEL,
    issueTitle: PRUNE_FAILURE_ISSUE_TITLE,
    issueMarker: PRUNE_FAILURE_ISSUE_MARKER,
    throttledLogPrefix: NOTIFY_THROTTLED_LOG_PREFIX,
    buildIssueBody,
    // The pruner runs hourly, dense enough that a failure streak would pile
    // up one comment per run without this — see RENOTIFY_INTERVAL_MS in
    // githubFailureNotifier.ts.
    renotifyIntervalMs: RENOTIFY_INTERVAL_MS,
  });
}

export function getPruneFailureNotifier(): PruneFailureNotifier {
  return createPruneFailureNotifier(createFetchGithubIssuesClient());
}
