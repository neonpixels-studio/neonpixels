// Shared by the audit, deploy, and project-URL failure notifiers (called via
// actions/github-script). Owns the one-tracking-issue-per-failure-streak
// lifecycle: find the open issue, open one or comment "still failing", and
// close on recovery. Each notifier supplies only its own label, marker, title,
// and message text. The GitHub client is always passed in by the caller, so
// the whole module is testable against a stub. CommonJS (.cjs) because
// package.json sets "type": "module".

// 100 is the API's max per_page. Needing a second page means over 100 open
// items carry the label, so pagination is not worth handling.
const LIST_PAGE_SIZE = 100;

// `listForRepo` returns pull requests as well as issues, and the label filter
// alone matches anything tagged for an unrelated reason. The body marker
// (invisible in rendered Markdown, and not in the title because humans edit
// titles) narrows the match to issues this tracker opened.
function isTrackedIssue(issueOrPullRequest, marker) {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(marker)
  );
}

function buildRunUrl(context) {
  const { owner, repo } = context.repo;
  return `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
}

// logName is the short name used in log lines and errors, e.g. "audit-failure".
function createFailureIssueTracker({
  label,
  marker,
  title,
  logName,
  buildIssueBody,
  buildRecoveryComment,
}) {
  // Returns every match, not just the first: the close path needs all of them
  // (a human reopening one, or two racing runs, could otherwise leave a second
  // tracked issue open forever).
  async function findOpenIssues({ github, owner, repo }) {
    const { data } = await github.rest.issues.listForRepo({
      owner,
      repo,
      state: "open",
      labels: label,
      per_page: LIST_PAGE_SIZE,
    });
    return data.filter((issue) => isTrackedIssue(issue, marker));
  }

  // Unguarded on purpose: a failure here should surface loudly in the
  // workflow log rather than leave a silently-broken notifier.
  async function notify({ github, context, core }) {
    const { owner, repo } = context.repo;
    const runUrl = buildRunUrl(context);

    const [existingIssue] = await findOpenIssues({ github, owner, repo });
    if (existingIssue) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: existingIssue.number,
        body: `Still failing. Latest run: ${runUrl}`,
      });
      core.info(
        `Commented on existing ${logName} issue #${existingIssue.number}.`,
      );
      return;
    }

    const { data: createdIssue } = await github.rest.issues.create({
      owner,
      repo,
      title,
      labels: [label],
      body: buildIssueBody(runUrl),
    });
    core.info(`Opened ${logName} issue #${createdIssue.number}.`);
  }

  // Closes first, comments second: closing is the state change that matters,
  // so a failed comment on an issue that did close is only a warning.
  async function closeIssue({ github, owner, repo, issue, runUrl, core }) {
    await github.rest.issues.update({
      owner,
      repo,
      issue_number: issue.number,
      state: "closed",
    });
    core.info(`Closed resolved ${logName} issue #${issue.number}.`);

    try {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: buildRecoveryComment(runUrl),
      });
    } catch (error) {
      core.warning(
        `Closed ${logName} issue #${issue.number} but could not post the recovery comment: ${error.message}`,
      );
    }
  }

  async function closeResolved({ github, context, core }) {
    const { owner, repo } = context.repo;
    const runUrl = buildRunUrl(context);

    const trackedIssues = await findOpenIssues({ github, owner, repo });
    if (trackedIssues.length === 0) {
      core.info(`No open ${logName} issue to close.`);
      return;
    }

    // One stuck issue must not stop the rest from closing; failures are
    // collected and thrown afterward so they still surface in the log.
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
        `Failed to close ${logName} issue(s): ${closeFailures.join("; ")}`,
      );
    }
  }

  return { findOpenIssues, notify, closeResolved };
}

module.exports = { createFailureIssueTracker, LIST_PAGE_SIZE };
