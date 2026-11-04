// Called from .github/workflows/security.yml's "notify-audit-failure" job
// (which runs only when the `audit` job it depends on fails on the Monday
// schedule) via actions/github-script. Extracted to a plain module (rather
// than left inline in the YAML `script:` block) so the duplicate-guard
// logic — the part of this with an actual failure mode — can be unit-tested
// against a stubbed `github` client instead of only grepped as source text.
// Kept as CommonJS (.cjs) rather than .js: package.json sets
// "type": "module", so a plain .js here would be parsed as ESM by Node and
// `module.exports`/`require` would fail at runtime in the workflow.
//
// The title is deliberately generic ("...workflow failed", not "...audit
// found an advisory"): the notify job fires on ANY failure in the `audit`
// job (checkout, npm ci, a registry blip, or the audit gate itself), so a
// title naming a specific cause would be misleading whenever the real cause
// was something else.
const { createFailureIssueTracker } = require("./failure-issue-tracker.cjs");

const ISSUE_TITLE = "Scheduled security audit workflow failed";
const AUDIT_FAILURE_LABEL = "audit-failure";

// Invisible in rendered Markdown, and written into the issue body rather
// than the title: a title is fair game for a human to edit during triage
// (e.g. appending the advisory name), which would break a title-based match
// on the very next scheduled run. The body marker survives that.
const ISSUE_MARKER = "<!-- neonpixels:audit-failure-notifier -->";

function buildIssueBody(runUrl) {
  return [
    ISSUE_MARKER,
    "The scheduled (Monday) security audit workflow failed.",
    "",
    `Failed run: ${runUrl}`,
    "",
    "Investigate the failure. Re-running this failed scheduled run once " +
      "resolved, or waiting for the next Monday run, closes this issue " +
      "automatically (see close-resolved-audit-failure.cjs) — the close " +
      "job only fires on the schedule trigger, not workflow_dispatch, since " +
      "that can be run against an arbitrary branch.",
    "Closing it manually early also resets the duplicate guard, letting the " +
      "next failure open a new one.",
  ].join("\n");
}

const tracker = createFailureIssueTracker({
  label: AUDIT_FAILURE_LABEL,
  marker: ISSUE_MARKER,
  title: ISSUE_TITLE,
  logName: "audit-failure",
  buildIssueBody,
  buildRecoveryComment: (runUrl) =>
    `The scheduled security audit passed again. Closing this issue.\n\nRecovered run: ${runUrl}`,
});

// Unguarded on purpose: a failure should surface loudly in the workflow log,
// since a silently-broken notifier is exactly what this feature prevents.
module.exports = tracker.notify;

module.exports.AUDIT_FAILURE_LABEL = AUDIT_FAILURE_LABEL;
module.exports.ISSUE_TITLE = ISSUE_TITLE;
module.exports.ISSUE_MARKER = ISSUE_MARKER;
// Plural lookup stays exported for tests and any caller needing every open
// tracked issue.
module.exports.findOpenAuditFailureIssues = tracker.findOpenIssues;
module.exports.closeResolved = tracker.closeResolved;
