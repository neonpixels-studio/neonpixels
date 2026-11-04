// Called from the "close-resolved-deploy-failure" job in
// .github/workflows/weekly-production-deploy.yml via actions/github-script.
// Recovery counterpart to notify-deploy-failure.cjs, mirroring
// close-resolved-audit-failure.cjs: close first, comment second, and a failed
// comment on an already-closed issue is a warning, not a failed close.
// Kept as CommonJS (.cjs) because package.json sets "type": "module".
const { findOpenDeployFailureIssues } = require("./notify-deploy-failure.cjs");

async function closeDeployFailureIssue({
  github,
  owner,
  repo,
  issue,
  runUrl,
  core,
}) {
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    state: "closed",
  });
  core.info(`Closed resolved deploy-failure issue #${issue.number}.`);

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `The production deploy succeeded again. Closing this issue.\n\nRecovered run: ${runUrl}`,
    });
  } catch (error) {
    core.warning(
      `Closed deploy-failure issue #${issue.number} but could not post the recovery comment: ${error.message}`,
    );
  }
}

module.exports = async function closeResolvedDeployFailure({
  github,
  context,
  core,
}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  // Unguarded on purpose, same as the notifier: a broken lookup should fail
  // loudly rather than let stale deploy-failure issues pile up.
  const trackedIssues = await findOpenDeployFailureIssues({
    github,
    owner,
    repo,
  });

  if (trackedIssues.length === 0) {
    core.info("No open deploy-failure issue to close.");
    return;
  }

  // One stuck issue must not stop the rest from closing; failures are
  // collected and thrown afterward so they still surface in the log.
  const closeFailures = [];
  for (const issue of trackedIssues) {
    try {
      await closeDeployFailureIssue({
        github,
        owner,
        repo,
        issue,
        runUrl,
        core,
      });
    } catch (error) {
      closeFailures.push(`#${issue.number}: ${error.message}`);
    }
  }

  if (closeFailures.length > 0) {
    throw new Error(
      `Failed to close deploy-failure issue(s): ${closeFailures.join("; ")}`,
    );
  }
};
