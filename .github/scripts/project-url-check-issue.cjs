// Called from .github/workflows/project-url-check.yml's notify and close jobs
// via actions/github-script. Configures the shared tracker
// (failure-issue-tracker.cjs) with its own label and marker so trackers never
// touch each other's issues; unit-tested against a stubbed `github` client.
// CommonJS (.cjs) because package.json sets "type": "module".
const { createFailureIssueTracker } = require("./failure-issue-tracker.cjs");

const ISSUE_TITLE = "Scheduled project URL check failed";
const PROJECT_URL_FAILURE_LABEL = "project-url-failure";
const ISSUE_MARKER = "<!-- neonpixels:project-url-check-notifier -->";

function buildIssueBody(runUrl) {
  return [
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

const tracker = createFailureIssueTracker({
  label: PROJECT_URL_FAILURE_LABEL,
  marker: ISSUE_MARKER,
  title: ISSUE_TITLE,
  logName: "project-url",
  buildIssueBody,
  recoveryMessage: "All project URLs responded again.",
});

module.exports = {
  notifyProjectUrlFailure: tracker.notify,
  closeResolvedProjectUrlFailure: tracker.closeResolved,
  ISSUE_TITLE,
  PROJECT_URL_FAILURE_LABEL,
  ISSUE_MARKER,
};
