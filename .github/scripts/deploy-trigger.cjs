// Run by .github/workflows/weekly-production-deploy.yml in two steps:
//   node .github/scripts/deploy-trigger.cjs recent
//     Decides whether a scheduled run should skip the deploy because main has
//     no commits in the last 7 days; writes `skip=true|false` to GITHUB_OUTPUT.
//   node .github/scripts/deploy-trigger.cjs title
//     Builds the unique trigger title, appends NETLIFY_DEPLOY_TITLE to
//     GITHUB_ENV for the verify step and prints the URL-encoded title on
//     stdout for the build hook call.
// Needs EVENT_NAME; `title` also needs GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT.
//
// Plain CommonJS (.cjs) for the same reason as verify-production-deploy.cjs:
// package.json sets "type": "module". The git call and file writes are
// injected so the logic is unit-testable without a repository.
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const SCHEDULE_EVENT = "schedule";
const WINDOW_DAYS = 7;
const DEPLOY_REF = "origin/main";
const SCHEDULED_TITLE = "Weekly production deploy";
const MANUAL_TITLE = "Manual production deploy";

function isScheduled(eventName) {
  return eventName === SCHEDULE_EVENT;
}

function countRecentCommits() {
  const output = execFileSync(
    "git",
    ["rev-list", "--count", `--since=${WINDOW_DAYS} days ago`, DEPLOY_REF],
    { encoding: "utf8" },
  );
  const count = Number.parseInt(output.trim(), 10);
  if (Number.isNaN(count)) {
    throw new Error(`Unexpected git rev-list output: "${output.trim()}"`);
  }
  return count;
}

function checkRecentCommits({
  eventName,
  countCommits = countRecentCommits,
  writeOutput,
  log = console.log,
}) {
  if (!isScheduled(eventName)) {
    writeOutput("skip=false");
    return false;
  }
  const recentCommits = countCommits();
  if (recentCommits === 0) {
    log(
      `main has no commits in the last ${WINDOW_DAYS} days; skipping production deploy.`,
    );
    writeOutput("skip=true");
    return true;
  }
  log(`main has ${recentCommits} commit(s) in the last ${WINDOW_DAYS} days.`);
  writeOutput("skip=false");
  return false;
}

function buildTriggerTitle({ eventName, runId, runAttempt }) {
  const baseTitle = isScheduled(eventName) ? SCHEDULED_TITLE : MANUAL_TITLE;
  return `${baseTitle} run ${runId} attempt ${runAttempt}`;
}

function encodeTitle(title) {
  return title.replace(/ /g, "+");
}

function requireEnv(env, name) {
  if (!env[name]) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return env[name];
}

function prepareTrigger({ env, writeEnv, print = console.log }) {
  const title = buildTriggerTitle({
    eventName: env.EVENT_NAME,
    runId: requireEnv(env, "GITHUB_RUN_ID"),
    runAttempt: requireEnv(env, "GITHUB_RUN_ATTEMPT"),
  });
  writeEnv(`NETLIFY_DEPLOY_TITLE=${title}`);
  print(encodeTitle(title));
  return title;
}

function appender(path) {
  return (line) => appendFileSync(path, `${line}\n`);
}

function main(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv;
  if (command === "recent") {
    checkRecentCommits({
      eventName: env.EVENT_NAME,
      writeOutput: appender(requireEnv(env, "GITHUB_OUTPUT")),
    });
    return;
  }
  if (command === "title") {
    prepareTrigger({ env, writeEnv: appender(requireEnv(env, "GITHUB_ENV")) });
    return;
  }
  throw new Error(
    `Unknown command "${command}"; expected "recent" or "title".`,
  );
}

module.exports = {
  isScheduled,
  countRecentCommits,
  checkRecentCommits,
  buildTriggerTitle,
  encodeTitle,
  prepareTrigger,
  main,
  WINDOW_DAYS,
  SCHEDULED_TITLE,
  MANUAL_TITLE,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
