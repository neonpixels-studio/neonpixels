// Run by .github/workflows/weekly-production-deploy.yml right after the
// Netlify build hook is fired. The hook call returns as soon as Netlify
// accepts the build, but the build command runs the full test suite and
// blocks on failure, so an accepted hook says nothing about whether
// production actually updated. This polls the Netlify API until the deploy
// reaches a terminal state and exits non-zero otherwise, which lets the
// workflow's notify job open an issue.
//
// Plain CommonJS (.cjs) for the same reason as notify-audit-failure.cjs:
// package.json sets "type": "module". All network and timing dependencies
// are injected so the polling logic is unit-testable without Netlify.
const NETLIFY_API_BASE_URL = "https://api.netlify.com/api/v1";
const POLL_INTERVAL_MS = 15 * 1000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const OUTCOME_SUCCESS = "success";
const OUTCOME_FAILURE = "failure";
const OUTCOME_CANCELLED = "cancelled";
const OUTCOME_TIMEOUT = "timeout";
const OUTCOME_PENDING = "pending";

const SUCCESS_STATES = new Set(["ready"]);
const FAILURE_STATES = new Set(["error", "rejected"]);
const CANCELLED_STATES = new Set(["cancelled", "canceled", "skipped"]);

function classifyDeployState(state) {
  if (SUCCESS_STATES.has(state)) {
    return OUTCOME_SUCCESS;
  }
  if (FAILURE_STATES.has(state)) {
    return OUTCOME_FAILURE;
  }
  if (CANCELLED_STATES.has(state)) {
    return OUTCOME_CANCELLED;
  }
  return OUTCOME_PENDING;
}

// Netlify build hooks respond with the created build; its id is all that is
// needed to find the deploy.
function parseBuildId(hookResponseBody) {
  let parsed;
  try {
    parsed = JSON.parse(hookResponseBody);
  } catch {
    throw new Error(
      `Build hook response was not JSON: ${String(hookResponseBody).slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed.id !== "string" || parsed.id === "") {
    throw new Error("Build hook response did not include a build id.");
  }
  return parsed.id;
}

function createNetlifyClient({ token, fetchImpl = fetch }) {
  async function getJson(path) {
    const response = await fetchImpl(`${NETLIFY_API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Netlify API ${path} responded ${response.status}.`);
    }
    return response.json();
  }

  // A build has no deploy_id until Netlify assigns one, so a missing id
  // reads as a pending (state-less) deploy rather than an error.
  async function fetchDeploy(buildId) {
    const build = await getJson(`/builds/${buildId}`);
    if (!build.deploy_id) {
      return { state: "new" };
    }
    return getJson(`/deploys/${build.deploy_id}`);
  }

  return { fetchDeploy };
}

async function pollDeployStatus({
  buildId,
  fetchDeploy,
  sleep,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}) {
  const deadline = now() + timeoutMs;
  let lastState = "unknown";
  while (now() < deadline) {
    const deploy = await fetchDeploy(buildId);
    lastState = deploy.state;
    const outcome = classifyDeployState(lastState);
    if (outcome !== OUTCOME_PENDING) {
      return { outcome, state: lastState, deploy };
    }
    await sleep(intervalMs);
  }
  return { outcome: OUTCOME_TIMEOUT, state: lastState, deploy: null };
}

function describeResult({ outcome, state, deploy }) {
  const detail = deploy?.error_message ? ` (${deploy.error_message})` : "";
  if (outcome === OUTCOME_SUCCESS) {
    return `Production deploy succeeded (state: ${state}).`;
  }
  if (outcome === OUTCOME_TIMEOUT) {
    return `Production deploy did not finish before the timeout (last state: ${state}).`;
  }
  return `Production deploy ${outcome} (state: ${state})${detail}.`;
}

function readRequiredEnv(env, name) {
  if (!env[name]) {
    throw new Error(
      `${name} is not set; cannot verify the production deploy. See the Deploys section of README.md.`,
    );
  }
  return env[name];
}

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function verifyProductionDeploy({
  env = process.env,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = console.log,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
} = {}) {
  const token = readRequiredEnv(env, "NETLIFY_AUTH_TOKEN");
  const buildId = parseBuildId(readRequiredEnv(env, "NETLIFY_HOOK_RESPONSE"));
  const { fetchDeploy } = createNetlifyClient({ token, fetchImpl });
  log(`Polling Netlify build ${buildId}.`);
  const result = await pollDeployStatus({
    buildId,
    fetchDeploy,
    sleep,
    now,
    intervalMs,
    timeoutMs,
  });
  const message = describeResult(result);
  log(message);
  if (result.outcome !== OUTCOME_SUCCESS) {
    throw new Error(message);
  }
  return result;
}

module.exports = verifyProductionDeploy;
module.exports.classifyDeployState = classifyDeployState;
module.exports.parseBuildId = parseBuildId;
module.exports.createNetlifyClient = createNetlifyClient;
module.exports.pollDeployStatus = pollDeployStatus;
module.exports.describeResult = describeResult;
module.exports.POLL_TIMEOUT_MS = POLL_TIMEOUT_MS;
module.exports.OUTCOME_SUCCESS = OUTCOME_SUCCESS;
module.exports.OUTCOME_FAILURE = OUTCOME_FAILURE;
module.exports.OUTCOME_CANCELLED = OUTCOME_CANCELLED;
module.exports.OUTCOME_TIMEOUT = OUTCOME_TIMEOUT;

if (require.main === module) {
  verifyProductionDeploy().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
