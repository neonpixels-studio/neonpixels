// Called from the "notify-deploy-failure" job in
// .github/workflows/weekly-production-deploy.yml via actions/github-script.
// Mirrors notify-audit-failure.cjs (marker in the body, one open issue per
// failure streak, comment instead of duplicating) with its own label and
// marker so the two notifiers never match each other's issues. Kept as
// CommonJS (.cjs) because package.json sets "type": "module".
const ISSUE_TITLE = "Weekly production deploy failed";
const DEPLOY_FAILURE_LABEL = "deploy-failure";
const ISSUE_MARKER = "<!-- neonpixels:deploy-failure-notifier -->";

// 100 is the API's max per_page; see notify-audit-failure.cjs.
const LIST_PAGE_SIZE = 100;

function isTrackedDeployFailureIssue(issueOrPullRequest) {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(ISSUE_MARKER)
  );
}

async function findOpenDeployFailureIssue({ github, owner, repo }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: DEPLOY_FAILURE_LABEL,
    per_page: LIST_PAGE_SIZE,
  });
  return data.find(isTrackedDeployFailureIssue);
}

function buildIssueBody(runUrl) {
  return [
    ISSUE_MARKER,
    "The weekly production deploy did not complete successfully, so " +
      "production is likely stale until the next run.",
    "",
    `Failed run: ${runUrl}`,
    "",
    "The Netlify build runs the full test suite and blocks on failure; " +
      "check the deploy log in Netlify, fix the cause on main, then re-run " +
      "the Weekly production deploy workflow. Close this issue once " +
      "production is fresh; closing it also lets the next failure open a " +
      "new one.",
  ].join("\n");
}

// Unguarded on purpose: a failure here should surface loudly in the
// workflow log rather than leave a silently-broken notifier.
module.exports = async function notifyDeployFailure({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  const existingIssue = await findOpenDeployFailureIssue({
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
      `Commented on existing deploy-failure issue #${existingIssue.number}.`,
    );
    return;
  }

  const { data: createdIssue } = await github.rest.issues.create({
    owner,
    repo,
    title: ISSUE_TITLE,
    labels: [DEPLOY_FAILURE_LABEL],
    body: buildIssueBody(runUrl),
  });
  core.info(`Opened deploy-failure issue #${createdIssue.number}.`);
};

module.exports.DEPLOY_FAILURE_LABEL = DEPLOY_FAILURE_LABEL;
module.exports.ISSUE_TITLE = ISSUE_TITLE;
module.exports.ISSUE_MARKER = ISSUE_MARKER;
