// Called from .github/workflows/security.yml's "Notify on scheduled audit
// failure" step via actions/github-script. Extracted to a plain module
// (rather than left inline in the YAML `script:` block) so the duplicate
// guard — the part of this with an actual failure mode — can be unit-tested
// against a stubbed `github` client instead of only grepped as source text.
const ISSUE_TITLE = "Scheduled dependency audit failed";
const AUDIT_FAILURE_LABEL = "audit-failure";

// `GET /repos/{owner}/{repo}/issues` (which `listForRepo` wraps) returns pull
// requests as well as issues. A PR carrying the `audit-failure` label for
// unrelated reasons (e.g. a dependency bump PR someone tagged for triage)
// would otherwise read as an existing open notification and permanently
// suppress real ones.
function isRealIssue(issueOrPullRequest) {
  return issueOrPullRequest.pull_request === undefined;
}

async function findOpenAuditFailureIssue({ github, owner, repo }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: AUDIT_FAILURE_LABEL,
  });
  return data.filter(isRealIssue)[0];
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
  // closes the existing one.
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
  await github.rest.issues.create({
    owner,
    repo,
    title: ISSUE_TITLE,
    labels: [AUDIT_FAILURE_LABEL],
    body: buildIssueBody(runUrl),
  });
};

module.exports.AUDIT_FAILURE_LABEL = AUDIT_FAILURE_LABEL;
module.exports.ISSUE_TITLE = ISSUE_TITLE;
