// Called from the "notify-deploy-failure" job in
// .github/workflows/weekly-production-deploy.yml via actions/github-script.
// Configures the shared tracker (failure-issue-tracker.cjs) with its own label
// and marker so notifiers never match each other's issues. Kept as
// CommonJS (.cjs) because package.json sets "type": "module".
const { createFailureIssueTracker } = require("./failure-issue-tracker.cjs");

const ISSUE_TITLE = "Weekly production deploy failed";
const DEPLOY_FAILURE_LABEL = "deploy-failure";
const ISSUE_MARKER = "<!-- neonpixels:deploy-failure-notifier -->";

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
      "the Weekly production deploy workflow. This issue closes " +
      "automatically after the next verified production deploy; closing " +
      "it manually also lets the next failure open a new one.",
  ].join("\n");
}

const tracker = createFailureIssueTracker({
  label: DEPLOY_FAILURE_LABEL,
  marker: ISSUE_MARKER,
  title: ISSUE_TITLE,
  logName: "deploy-failure",
  buildIssueBody,
  buildRecoveryComment: (runUrl) =>
    `The production deploy succeeded again. Closing this issue.\n\nRecovered run: ${runUrl}`,
});

module.exports = tracker.notify;

module.exports.DEPLOY_FAILURE_LABEL = DEPLOY_FAILURE_LABEL;
module.exports.ISSUE_TITLE = ISSUE_TITLE;
module.exports.ISSUE_MARKER = ISSUE_MARKER;
module.exports.findOpenDeployFailureIssues = tracker.findOpenIssues;
module.exports.closeResolved = tracker.closeResolved;
