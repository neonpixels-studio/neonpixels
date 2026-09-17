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
const ISSUE_TITLE = "Scheduled security audit workflow failed";
const AUDIT_FAILURE_LABEL = "audit-failure";

// Invisible in rendered Markdown, and written into the issue body rather
// than the title: a title is fair game for a human to edit during triage
// (e.g. appending the advisory name), which would break a title-based match
// on the very next scheduled run. The body marker survives that.
const ISSUE_MARKER = "<!-- neonpixels:audit-failure-notifier -->";

// GitHub caps listForRepo (GET /repos/{owner}/{repo}/issues) at 30 results
// per page by default. A long streak of unrelated items carrying this label
// could otherwise push the real notification issue past page 1 and defeat
// the duplicate guard below. 100 is the API's max per_page.
const LIST_PAGE_SIZE = 100;

// `GET /repos/{owner}/{repo}/issues` (which `listForRepo` wraps) returns pull
// requests as well as issues, and the `labels` filter alone matches anything
// tagged `audit-failure` for an unrelated reason (a PR, or an issue someone
// mislabeled during triage). Requiring the marker in the body narrows this
// to issues this script itself opened.
function isTrackedAuditFailureIssue(issueOrPullRequest) {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(ISSUE_MARKER)
  );
}

// Exported (rather than kept private) so close-resolved-audit-failure.cjs
// can reuse this exact lookup instead of re-deriving the label/marker
// matching rules: the close path must target precisely the issues this
// script opens, and duplicating the guard here would let the two drift out
// of sync.
async function findOpenAuditFailureIssue({ github, owner, repo }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: AUDIT_FAILURE_LABEL,
    per_page: LIST_PAGE_SIZE,
  });
  return data.find(isTrackedAuditFailureIssue);
}

function buildIssueBody(runUrl) {
  return [
    ISSUE_MARKER,
    "The scheduled (Monday) security audit workflow failed.",
    "",
    `Failed run: ${runUrl}`,
    "",
    "Investigate the failed run and re-run the workflow once resolved.",
    "This issue closes automatically the next time the scheduled audit succeeds " +
      "(see close-resolved-audit-failure.cjs); closing it manually early also " +
      "resets the duplicate guard, letting the next failure open a new one.",
  ].join("\n");
}

module.exports = async function notifyAuditFailure({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  // One open issue per failure streak: comment on the existing issue rather
  // than opening a duplicate, until a human closes it. Left unguarded (no
  // try/catch) deliberately for both branches below: a failure here should
  // surface loudly in the workflow log rather than be swallowed, since a
  // silently-broken notifier is exactly the failure mode this feature
  // exists to prevent.
  const existingIssue = await findOpenAuditFailureIssue({
    github,
    owner,
    repo,
  });
  if (existingIssue) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existingIssue.number,
      body: `Still failing. Latest run: ${runUrl}`,
    });
    core.info(
      `Commented on existing audit-failure issue #${existingIssue.number}.`,
    );
    return;
  }

  const { data: createdIssue } = await github.rest.issues.create({
    owner,
    repo,
    title: ISSUE_TITLE,
    labels: [AUDIT_FAILURE_LABEL],
    body: buildIssueBody(runUrl),
  });
  core.info(`Opened audit-failure issue #${createdIssue.number}.`);
};

module.exports.AUDIT_FAILURE_LABEL = AUDIT_FAILURE_LABEL;
module.exports.ISSUE_TITLE = ISSUE_TITLE;
module.exports.ISSUE_MARKER = ISSUE_MARKER;
module.exports.findOpenAuditFailureIssue = findOpenAuditFailureIssue;
