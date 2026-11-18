// Run by .github/workflows/weekly-production-deploy.yml in two steps:
//   node .github/scripts/deploy-trigger.cjs recent
//     Decides whether a scheduled run should skip the deploy because main has
//     no commits in the last 7 days; writes `skip=true|false` to GITHUB_OUTPUT.
//   node .github/scripts/deploy-trigger.cjs title
//     Builds the unique trigger title, appends NETLIFY_DEPLOY_TITLE to
//     GITHUB_ENV for the verify step and prints the URL-encoded title on
//     stdout for the build hook call.
//   node .github/scripts/deploy-trigger.cjs head-unchanged
//     Fails when main has moved past the commit this run started from (the
//     one the e2e gate tested), since Netlify builds whatever main is when
//     the hook fires.
// Needs EVENT_NAME; `title` also needs GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT;
// `head-unchanged` needs GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN (and does
// not use EVENT_NAME).
//
// Plain CommonJS (.cjs) for the same reason as verify-production-deploy.cjs:
// package.json sets "type": "module". The git call and file writes are
// injected so the logic is unit-testable without a repository.
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const SCHEDULE_EVENT = "schedule";
const WINDOW_DAYS = 7;
const DEPLOY_BRANCH = "main";
const DEPLOY_REF = `origin/${DEPLOY_BRANCH}`;
const SCHEDULED_TITLE = "Weekly production deploy";
const MANUAL_TITLE = "Manual production deploy";
const GITHUB_API_BASE_URL = "https://api.github.com";

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
    eventName: requireEnv(env, "EVENT_NAME"),
    runId: requireEnv(env, "GITHUB_RUN_ID"),
    runAttempt: requireEnv(env, "GITHUB_RUN_ATTEMPT"),
  });
  writeEnv(`NETLIFY_DEPLOY_TITLE=${title}`);
  print(encodeTitle(title));
  return title;
}

async function fetchMainHeadSha({ repository, token, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `${GITHUB_API_BASE_URL}/repos/${repository}/commits/${DEPLOY_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub API request for the main head failed with status ${response.status}`,
    );
  }
  const { sha } = await response.json();
  if (!sha) {
    throw new Error("GitHub API response for the main head had no sha");
  }
  return sha;
}

async function checkHeadUnchanged({
  expectedSha,
  fetchHeadSha,
  log = console.log,
}) {
  const headSha = await fetchHeadSha();
  if (headSha !== expectedSha) {
    throw new Error(
      "main moved since the e2e gate ran; start a new run (a re-run reuses the old commit).",
    );
  }
  log(`main is still at ${expectedSha}.`);
  return true;
}

function escapeAnnotation(message) {
  return message
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function appender(path) {
  return (line) => appendFileSync(path, `${line}\n`);
}

// Sync for `recent` and `title`; `head-unchanged` returns a promise.
function main(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv;
  if (command === "recent") {
    checkRecentCommits({
      eventName: requireEnv(env, "EVENT_NAME"),
      writeOutput: appender(requireEnv(env, "GITHUB_OUTPUT")),
    });
    return;
  }
  if (command === "title") {
    prepareTrigger({ env, writeEnv: appender(requireEnv(env, "GITHUB_ENV")) });
    return;
  }
  if (command === "head-unchanged") {
    const repository = requireEnv(env, "GITHUB_REPOSITORY");
    const token = requireEnv(env, "GH_TOKEN");
    return checkHeadUnchanged({
      expectedSha: requireEnv(env, "GITHUB_SHA"),
      fetchHeadSha: () => fetchMainHeadSha({ repository, token }),
    });
  }
  throw new Error(
    `Unknown command "${command}"; expected "recent", "title" or "head-unchanged".`,
  );
}

module.exports = {
  isScheduled,
  countRecentCommits,
  checkRecentCommits,
  buildTriggerTitle,
  encodeTitle,
  prepareTrigger,
  fetchMainHeadSha,
  checkHeadUnchanged,
  escapeAnnotation,
  main,
  WINDOW_DAYS,
  SCHEDULED_TITLE,
  MANUAL_TITLE,
};

if (require.main === module) {
  const fail = (error) => {
    console.error(`::error::${escapeAnnotation(error.message)}`);
    process.exit(1);
  };
  try {
    Promise.resolve(main()).catch(fail);
  } catch (error) {
    fail(error);
  }
}
