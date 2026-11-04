// Called from the "close-resolved-deploy-failure" job in
// .github/workflows/weekly-production-deploy.yml via actions/github-script.
// Recovery counterpart to notify-deploy-failure.cjs; the close logic lives in
// the shared tracker (failure-issue-tracker.cjs) configured there.
// Kept as CommonJS (.cjs) because package.json sets "type": "module".
const { closeResolved } = require("./notify-deploy-failure.cjs");

module.exports = closeResolved;
