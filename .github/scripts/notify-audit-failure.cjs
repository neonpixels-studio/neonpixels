// Called from .github/workflows/security.yml's "Notify on scheduled audit
// failure" step via actions/github-script. Extracted to a plain module
// (rather than left inline in the YAML `script:` block) so the duplicate
// guard — the part of this with an actual failure mode — can be unit-tested
// against a stubbed `github` client instead of only grepped as source text.
// Kept as CommonJS (.cjs) rather than .js: package.json sets
// "type": "module", so a plain .js here would be parsed as ESM by Node and
// `module.exports`/`require` would fail at runtime in the workflow.
const ISSUE_TITLE = "Scheduled dependency audit failed";
const AUDIT_FAILURE_LABEL = "audit-failure";

// GitHub caps listForRepo (GET /repos/{owner}/{repo}/issues) at 30 results
// per page by default. A long streak of unrelated items carrying this label
// could otherwise push the real notification issue past page 1 and defeat
// the duplicate guard below. 100 is the API's max per_page.
const LIST_PAGE_SIZE = 100;

// `GET /repos/{owner}/{repo}/issues` (which `listForRepo` wraps) returns pull
// requests as well as issues, and matches on label alone, so anything tagged
// `audit-failure` for an unrelated reason (a PR, or an issue someone
// mislabeled during triage) would otherwise read as an existing open
// notification and permanently suppress real ones. Matching on both the
// label and the exact title narrows this to issues this script itself opened.
function isTrackedAuditFailureIssue(issueOrPullRequest) {
  return (
    !issueOrPullRequest.pull_request && issueOrPullRequest.title === ISSUE_TITLE
  );
}

async function findOpenAuditFailureIssue({ github, owner, repo }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: AUDIT_FAILURE_LABEL,
    per_page: LIST_PAGE_SIZE,
  });
  return data.filter(isTrackedAuditFailureIssue)[0];
}

function buildIssueBody(runUrl) {
  return [
    "The scheduled (Monday) dependency audit failed.",
    "",
    `Failed run: ${runUrl}`,
    "",
    "Investigate the advisory and re-run the workflow once resolved.",
    "This issue is a duplicate guard: closing it lets the next failure open a new one.",
  ].join("\n");
}

module.exports = async function notifyAuditFailure({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  // One open issue per failure streak: skip creating another until a human
  // closes the existing one. Left unguarded (no try/catch) deliberately: a
  // failure here should surface loudly in the workflow log rather than be
  // swallowed, since a silently-broken notifier is exactly the failure mode
  // this feature exists to prevent.
  const existingIssue = await findOpenAuditFailureIssue({
    github,
    owner,
    repo,
  });
  if (existingIssue) {
    core.info(
      `An open audit-failure issue already exists (#${existingIssue.number}); skipping.`,
    );
    return;
  }

  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
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
