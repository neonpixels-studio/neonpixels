import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Scheduled liveness check for every outbound target the homepage depends on:
// the four project domains (PROJECTS in theme/data/projects.ts) and the
// /dashboard redirect target (netlify.toml). The URL list is read from those
// two files at run time, so adding or moving a project can never leave this
// check watching a stale copy. Run by .github/workflows/project-url-check.yml.
//
// Executed with plain `node` against this .ts file directly (native type
// stripping), like ../security/checkOverrideCompatibility.ts, so it may only
// use Node built-ins and cannot import the theme data (extensionless imports
// do not resolve outside Vite). The theme file is therefore read as text; a
// unit test pins the extraction to the real PROJECTS export.

const PROJECTS_PATH = ".vitepress/theme/data/projects.ts";
const NETLIFY_TOML_PATH = "netlify.toml";
const DASHBOARD_PATH = "/dashboard";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2_000;
const MIN_ALIVE_STATUS = 200;
const MAX_ALIVE_STATUS = 399;
// Statuses a host may return for HEAD while GET works; retried once as GET.
const HEAD_UNSUPPORTED_STATUSES = [405, 501];

const PROJECT_URL_PATTERN = /^\s*url:\s*"(https?:\/\/[^"]+)"/gm;
const DASHBOARD_REDIRECT_PATTERN = new RegExp(
  `from\\s*=\\s*"${DASHBOARD_PATH}"\\s*\\n\\s*to\\s*=\\s*"(https?://[^"]+)"`,
);

export type UrlTarget = {
  label: string;
  url: string;
};

export type UrlCheckResult = UrlTarget & {
  ok: boolean;
  detail: string;
};

export type FetchLike = (
  _url: string,
  _init: { method: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

export function extractProjectTargets(projectsSource: string): UrlTarget[] {
  return [...projectsSource.matchAll(PROJECT_URL_PATTERN)].map((match) => ({
    label: `project ${match[1]}`,
    url: match[1],
  }));
}

export function extractDashboardTarget(netlifyToml: string): UrlTarget {
  const match = netlifyToml.match(DASHBOARD_REDIRECT_PATTERN);
  if (!match) {
    throw new Error(`No ${DASHBOARD_PATH} redirect found in netlify.toml`);
  }
  return { label: `${DASHBOARD_PATH} redirect target`, url: match[1] };
}

export function isAliveStatus(status: number) {
  return status >= MIN_ALIVE_STATUS && status <= MAX_ALIVE_STATUS;
}

function sleep(milliseconds: number) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

// Redirects are not followed: a 3xx from the target proves it is up, and
// following it would instead test wherever it points.
async function requestStatus(
  url: string,
  method: "HEAD" | "GET",
  fetchImpl: FetchLike,
) {
  const response = await fetchImpl(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const { status } = response;
  await response.body?.cancel().catch(() => {});
  return status;
}

async function probeStatus(url: string, fetchImpl: FetchLike) {
  const headStatus = await requestStatus(url, "HEAD", fetchImpl);
  if (!HEAD_UNSUPPORTED_STATUSES.includes(headStatus)) {
    return headStatus;
  }
  return requestStatus(url, "GET", fetchImpl);
}

// Node's fetch throws TypeError("fetch failed") with the real reason (DNS,
// refused, certificate) in `cause`; surface it so the summary is actionable.
function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const causeText = cause?.code ?? cause?.message;
  return causeText ? `${error.message} (${causeText})` : error.message;
}

async function attemptProbe(url: string, fetchImpl: FetchLike) {
  try {
    const status = await probeStatus(url, fetchImpl);
    return { ok: isAliveStatus(status), detail: `HTTP ${status}` };
  } catch (error) {
    return { ok: false, detail: `request failed: ${describeError(error)}` };
  }
}

export async function checkTarget(
  target: UrlTarget,
  fetchImpl: FetchLike,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<UrlCheckResult> {
  let outcome = await attemptProbe(target.url, fetchImpl);
  for (let attempt = 1; attempt < MAX_ATTEMPTS && !outcome.ok; attempt++) {
    await sleep(retryDelayMs);
    outcome = await attemptProbe(target.url, fetchImpl);
  }
  return { ...target, ...outcome };
}

export function formatResult(result: UrlCheckResult) {
  return `${result.ok ? "OK  " : "FAIL"} ${result.label} (${result.url}): ${result.detail}`;
}

export function loadTargets(root: string): UrlTarget[] {
  const projectsSource = readFileSync(resolve(root, PROJECTS_PATH), "utf8");
  const netlifyToml = readFileSync(resolve(root, NETLIFY_TOML_PATH), "utf8");
  const projectTargets = extractProjectTargets(projectsSource);
  if (projectTargets.length === 0) {
    throw new Error(`No project urls found in ${PROJECTS_PATH}`);
  }
  return [...projectTargets, extractDashboardTarget(netlifyToml)];
}

export async function checkAll(
  targets: UrlTarget[],
  fetchImpl: FetchLike,
  retryDelayMs = RETRY_DELAY_MS,
) {
  return Promise.all(
    targets.map((target) => checkTarget(target, fetchImpl, retryDelayMs)),
  );
}

function writeStepSummary(summaryPath: string | undefined, lines: string[]) {
  if (!summaryPath) {
    return;
  }
  appendFileSync(
    summaryPath,
    `${lines.map((line) => `- ${line}`).join("\n")}\n`,
  );
}

export type RunOptions = {
  root: string;
  fetchImpl: FetchLike;
  summaryPath?: string;
  retryDelayMs?: number;
};

// Returns the process exit code (1 when any target is down) rather than
// exiting, so the gate that decides whether the workflow fails is testable.
export async function run({
  root,
  fetchImpl,
  summaryPath,
  retryDelayMs = RETRY_DELAY_MS,
}: RunOptions) {
  const targets = loadTargets(root);
  const results = await checkAll(targets, fetchImpl, retryDelayMs);
  const lines = results.map(formatResult);
  console.log(lines.join("\n"));
  writeStepSummary(summaryPath, lines);

  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) {
    return 0;
  }
  console.error(`${failures.length} of ${results.length} targets are down.`);
  return 1;
}

// Fail loud rather than silently skip the check on a Node without
// import.meta.main (<22.18 / <24.2): a silent exit 0 would close the issue.
if (import.meta.main === undefined) {
  throw new Error(
    "import.meta.main is unavailable on this Node version; need >=22.18 or >=24.2",
  );
}

if (import.meta.main) {
  run({
    root: process.cwd(),
    fetchImpl: fetch,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
