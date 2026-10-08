// Run by .github/workflows/weekly-production-deploy.yml right after the
// Netlify build hook is fired. The hook call returns as soon as Netlify
// accepts the build, but the build command runs the full test suite and
// blocks on failure, so an accepted hook says nothing about whether
// production actually updated. This polls the Netlify API until the deploy
// reaches a terminal state and exits non-zero otherwise, which lets the
// workflow's notify job open an issue. Needs NETLIFY_AUTH_TOKEN,
// NETLIFY_SITE_ID and NETLIFY_DEPLOY_TITLE (the unique trigger title).
//
// Plain CommonJS (.cjs) for the same reason as notify-audit-failure.cjs:
// package.json sets "type": "module". All network and timing dependencies
// are injected so the polling logic is unit-testable without Netlify.
const NETLIFY_API_BASE_URL = "https://api.netlify.com/api/v1";
const POLL_INTERVAL_MS = 15 * 1000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;
// Only recent deploys can be ours; the unique title does the real matching.
const DEPLOYS_PAGE_SIZE = 20;
const NOT_FOUND_STATE = "not found";

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

class NetlifyApiError extends Error {
  constructor(path, status) {
    super(`Netlify API ${path} responded ${status}.`);
    this.status = status;
  }
}

// 404 means a wrong site id, which retrying cannot fix.
const FATAL_STATUSES = new Set([401, 403, 404]);

function isFatalError(error) {
  return error instanceof NetlifyApiError && FATAL_STATUSES.has(error.status);
}

// The hook response body is not relied on: the deploy is found by the unique
// trigger title the workflow passes to the hook, which Netlify records as
// the deploy title.
function createNetlifyClient({ token, siteId, fetchImpl = fetch }) {
  async function getJson(path) {
    const response = await fetchImpl(`${NETLIFY_API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new NetlifyApiError(path, response.status);
    }
    return response.json();
  }

  // The deploy may not be listed yet right after the hook fires, so no match
  // reads as pending rather than an error.
  async function fetchDeploy(deployTitle) {
    const deploys = await getJson(
      `/sites/${encodeURIComponent(siteId)}/deploys?production=true&per_page=${DEPLOYS_PAGE_SIZE}`,
    );
    return deploys.find((deploy) => deploy.title === deployTitle) ?? null;
  }

  return { fetchDeploy };
}

// One transient API error (5xx, network blip) should not fail a deploy that
// is actually fine, so only a run of consecutive errors, or an auth error,
// is rethrown.
async function fetchWithRetry({ fetchDeploy, deployTitle, state }) {
  try {
    const deploy = await fetchDeploy(deployTitle);
    state.consecutiveErrors = 0;
    return deploy;
  } catch (error) {
    state.consecutiveErrors += 1;
    if (
      isFatalError(error) ||
      state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
    ) {
      throw error;
    }
    return null;
  }
}

async function pollDeployStatus({
  deployTitle,
  fetchDeploy,
  sleep,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}) {
  const deadline = now() + timeoutMs;
  const retryState = { consecutiveErrors: 0 };
  let lastState = NOT_FOUND_STATE;
  while (now() < deadline) {
    const deploy = await fetchWithRetry({
      fetchDeploy,
      deployTitle,
      state: retryState,
    });
    lastState = deploy?.state ?? lastState;
    const outcome = deploy ? classifyDeployState(lastState) : OUTCOME_PENDING;
    if (outcome !== OUTCOME_PENDING) {
      return { outcome, state: lastState, deploy };
    }
    await sleep(intervalMs);
  }
  return { outcome: OUTCOME_TIMEOUT, state: lastState, deploy: null };
}

function describeResult({ outcome, state, deploy }) {
  const detail = deploy?.error_message
    ? ` (${deploy.error_message.replace(/\s+/g, " ")})`
    : "";
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

// Workflow commands are line-based, so text from Netlify must not be able
// to end the message or start a new command.
function escapeWorkflowCommand(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
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
  const siteId = readRequiredEnv(env, "NETLIFY_SITE_ID");
  const deployTitle = readRequiredEnv(env, "NETLIFY_DEPLOY_TITLE");
  const { fetchDeploy } = createNetlifyClient({ token, siteId, fetchImpl });
  log(`Polling Netlify for the deploy titled "${deployTitle}".`);
  const result = await pollDeployStatus({
    deployTitle,
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
module.exports.createNetlifyClient = createNetlifyClient;
module.exports.pollDeployStatus = pollDeployStatus;
module.exports.describeResult = describeResult;
module.exports.escapeWorkflowCommand = escapeWorkflowCommand;
module.exports.NetlifyApiError = NetlifyApiError;
module.exports.MAX_CONSECUTIVE_ERRORS = MAX_CONSECUTIVE_ERRORS;
module.exports.POLL_TIMEOUT_MS = POLL_TIMEOUT_MS;
module.exports.OUTCOME_SUCCESS = OUTCOME_SUCCESS;
module.exports.OUTCOME_FAILURE = OUTCOME_FAILURE;
module.exports.OUTCOME_CANCELLED = OUTCOME_CANCELLED;
module.exports.OUTCOME_TIMEOUT = OUTCOME_TIMEOUT;

if (require.main === module) {
  verifyProductionDeploy().catch((error) => {
    console.error(`::error::${escapeWorkflowCommand(error.message)}`);
    process.exit(1);
  });
}
