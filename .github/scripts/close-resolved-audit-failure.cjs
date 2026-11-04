// Called from .github/workflows/security.yml's "close-resolved-audit-failure"
// job (which runs only when the `audit` job it depends on succeeds on the
// Monday schedule) via actions/github-script. Kept as a plain module so it is
// unit-tested against a stubbed `github` client. CommonJS (.cjs) because
// package.json sets "type": "module".
//
// The close logic lives in the shared tracker (failure-issue-tracker.cjs),
// configured once in notify-audit-failure.cjs, so the close path always
// targets exactly the issue(s) the notifier opened.
const { closeResolved } = require("./notify-audit-failure.cjs");

module.exports = closeResolved;
