// Called from .github/workflows/project-url-check.yml's notify and close jobs
// via actions/github-script. Mirrors notify-audit-failure.cjs and
// close-resolved-audit-failure.cjs (one open tracking issue per failure
// streak, matched by label AND a body marker, closed on recovery), but with
// its own label and marker so the two trackers never touch each other's
// issues. Both directions live in this one module because they share the
// lookup; it is unit-tested against a stubbed `github` client. CommonJS
// (.cjs) because package.json sets "type": "module".
// @todo This is the third copy of the one-tracking-issue-per-failure-streak
// logic (see notify-audit-failure.cjs, close-resolved-audit-failure.cjs).
// Extract a shared createFailureIssueTracker and migrate all of them.
const ISSUE_TITLE = "Scheduled project URL check failed";
const PROJECT_URL_FAILURE_LABEL = "project-url-failure";
const ISSUE_MARKER = "<!-- neonpixels:project-url-check-notifier -->";
const LIST_PAGE_SIZE = 100;

function isTrackedIssue(issueOrPullRequest) {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(ISSUE_MARKER)
  );
}

async function findOpenTrackedIssues({ github, owner, repo }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: PROJECT_URL_FAILURE_LABEL,
    per_page: LIST_PAGE_SIZE,
  });
  return data.filter(isTrackedIssue);
}

function buildRunUrl(context) {
  const { owner, repo } = context.repo;
  return `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
}

function buildIssueBody(runUrl) {
  return [
    ISSUE_MARKER,
    "The scheduled project URL check failed. At least one project domain or " +
      "the /dashboard redirect target did not answer with a 2xx/3xx status, " +
      "or the check itself broke.",
    "",
    `Failed run (the job summary lists each URL): ${runUrl}`,
    "",
    "This issue closes automatically when a later scheduled run passes. " +
      "Closing it manually early lets the next failure open a new one.",
  ].join("\n");
}

async function notifyProjectUrlFailure({ github, context, core }) {
  const { owner, repo } = context.repo;
  const runUrl = buildRunUrl(context);

  const [existingIssue] = await findOpenTrackedIssues({ github, owner, repo });
  if (existingIssue) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existingIssue.number,
      body: `Still failing. Latest run: ${runUrl}`,
    });
    core.info(
      `Commented on existing project-url issue #${existingIssue.number}.`,
    );
    return;
  }

  const { data: createdIssue } = await github.rest.issues.create({
    owner,
    repo,
    title: ISSUE_TITLE,
    labels: [PROJECT_URL_FAILURE_LABEL],
    body: buildIssueBody(runUrl),
  });
  core.info(`Opened project-url issue #${createdIssue.number}.`);
}

// Closes first, comments second: a failed comment on an issue that did close
// is only a warning, not a failed close.
async function closeIssue({ github, owner, repo, issue, runUrl, core }) {
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    state: "closed",
  });
  core.info(`Closed resolved project-url issue #${issue.number}.`);

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `All project URLs responded again. Closing this issue.\n\nRecovered run: ${runUrl}`,
    });
  } catch (error) {
    core.warning(
      `Closed project-url issue #${issue.number} but could not post the recovery comment: ${error.message}`,
    );
  }
}

async function closeResolvedProjectUrlFailure({ github, context, core }) {
  const { owner, repo } = context.repo;
  const runUrl = buildRunUrl(context);

  const trackedIssues = await findOpenTrackedIssues({ github, owner, repo });
  if (trackedIssues.length === 0) {
    core.info("No open project-url issue to close.");
    return;
  }

  // One stuck issue must not stop the rest from closing; fail loud afterward.
  const closeFailures = [];
  for (const issue of trackedIssues) {
    try {
      await closeIssue({ github, owner, repo, issue, runUrl, core });
    } catch (error) {
      closeFailures.push(`#${issue.number}: ${error.message}`);
    }
  }

  if (closeFailures.length > 0) {
    throw new Error(
      `Failed to close project-url issue(s): ${closeFailures.join("; ")}`,
    );
  }
}

module.exports = {
  notifyProjectUrlFailure,
  closeResolvedProjectUrlFailure,
  ISSUE_TITLE,
  PROJECT_URL_FAILURE_LABEL,
  ISSUE_MARKER,
};
