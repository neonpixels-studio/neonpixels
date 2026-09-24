import { errorMessage } from "./errorMessage";

// Generic GitHub-issue duplicate-guard notifier, extracted so a second
// scheduled Function's failure notifier (csp-report-summary's, in
// notifySummaryFailure.ts) can reuse the exact same seam as the first
// (csp-report-prune's, in notifyPruneFailure.ts) instead of re-deriving it —
// see issue #137. Everything here is deliberately failure-type-agnostic: no
// prune- or summary-specific label/title/marker lives in this file, only the
// mechanics both notifiers share (fetch-based GitHub REST client, error
// redaction, re-notify throttling, and the list/comment/create decision
// tree). Each concrete notifier supplies its own label/title/marker/body via
// FailureNotifierConfig and gets the same one-open-issue-per-failure-streak
// behavior notify-audit-failure.cjs established for the scheduled security
// audit workflow.

export type GithubIssueOrPullRequest = {
  number: number;
  body?: string;
  pull_request?: unknown;
  // Used as the re-notify fallback timestamp below: a notifier's own *first*
  // notification for a failure streak is the moment it opened this issue,
  // so before any of its own comments exist, throttling from here is
  // correct. Once the notifier has posted a comment, that comment's
  // created_at takes over — see resolveLastNotifiedAt.
  created_at?: string;
};

// A single comment on a tracked issue. Only the fields the duplicate-guard
// needs to identify a notifier's own comments and time them.
export type GithubComment = {
  body?: string;
  created_at?: string;
};

// The four GitHub capabilities a notifier needs, so tests can inject a fake
// without mocking `fetch`/the GitHub API.
export type GithubIssuesClient = {
  listOpenIssuesByLabel(_label: string): Promise<GithubIssueOrPullRequest[]>;
  createIssue(_input: {
    title: string;
    labels: string[];
    body: string;
  }): Promise<void>;
  createComment(_issueNumber: number, _body: string): Promise<void>;
  // Only called once a tracked issue is already found (the failure path) —
  // see the re-notify throttle below. Not needed on the "open a fresh
  // issue" path, so it stays off the hot path for a healthy run, and is
  // skipped entirely by a notifier that disables the throttle (see
  // renotifyIntervalMs on FailureNotifierConfig). `sinceIso` is the
  // throttle window's start, computed by the caller (see notify() below)
  // rather than inside an adapter — domain policy (renotifyIntervalMs)
  // stays in the notifier, so a fake client in tests can observe and honor
  // the exact same window a real GitHub call would.
  listComments(
    _issueNumber: number,
    _sinceIso: string,
  ): Promise<GithubComment[]>;
};

// GitHub caps the issues list endpoint at 30 results per page by default;
// 100 is the API's max per_page. Mirrors LIST_PAGE_SIZE in
// notify-audit-failure.cjs for the same reason: a long streak of unrelated
// items carrying a notifier's label shouldn't be able to push the real
// notification issue past page 1 and defeat the duplicate guard below.
const LIST_PAGE_SIZE = 100;

// A failed run's error text isn't a closed set — an upstream HTTP client can
// surface request URLs (potentially carrying credentials in a query string)
// in its message. Redacted and length-capped before it's published into a
// GitHub issue body/comment on a repo that may be public. The cap also keeps
// this under GitHub's ~65536-char issue/comment body limit — an uncapped
// message on a large failure would otherwise make the notification itself
// fail (422), which is exactly when it's most needed.
const MAX_REPORTED_ERROR_LENGTH = 500;

// Two independent redaction passes, not one combined pattern: a URL and a
// bearer-style credential can each appear without the other (a token in a
// header, reported without a URL; a URL with no credential in it), so both
// must run regardless of whether the other matched.
const URL_PATTERN = /https?:\/\/\S+/g;
// Matches common token shapes an upstream HTTP client might echo back in an
// error message: an explicit "Bearer <token>"/"token: <token>" credential
// (requiring 12+ credential-shaped characters after the connector, so
// ordinary English like "token expired" or "auth token is invalid" isn't
// mistaken for one and redacted into uselessness — a real bearer token/PAT
// is always far longer than any word that would legitimately follow "token"
// or "bearer" in a human-readable error message), or a GitHub/Netlify-style
// prefixed token (gh_, ghp_, ghs_, nfp_, etc., unconditionally, since that
// prefix alone is already a strong enough signal regardless of length).
const SECRET_PATTERN =
  /\b(?:bearer|token)[=:\s]+[A-Za-z0-9_\-.+/]{12,}=*|\bgh[a-z]*_\S+|\bnfp_\S+/gi;

export function sanitizeReportedError(errorMessage: string): string {
  const redacted = errorMessage
    .replace(URL_PATTERN, "[url redacted]")
    .replace(SECRET_PATTERN, "[secret redacted]");
  if (redacted.length <= MAX_REPORTED_ERROR_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_REPORTED_ERROR_LENGTH)}… (truncated)`;
}

// A run's scheduled cadence is what makes a fixed re-notify window
// meaningful at all: at the pruner's hourly cadence, a failure streak would
// otherwise bury the original diagnosis under one near-identical "still
// failing" comment per run, so RENOTIFY_INTERVAL_MS below suppresses that.
//
// This used to throttle off the issue's `updated_at`, which GitHub bumps on
// *any* activity — a human comment, label change, or edit — not just a
// notifier's own comments. That silenced re-notification for up to
// RENOTIFY_INTERVAL_MS after unrelated human activity even while the
// underlying failure kept changing (see #139). Instead this throttles off
// the created_at of a notifier's own last comment (marked with the
// configured issueMarker, same as the issue body — see
// resolveLastNotifiedAt), found via one extra `listComments` call on the
// failure path (an existing tracked issue is already found). That call is
// deliberately confined to the failure path rather than made unconditional:
// a healthy run never reaches here at all, and the common failure case
// (first failure of a streak) opens a fresh issue instead of listing
// comments on one.
//
// A notifier whose schedule is already sparser than any meaningful window
// (e.g. the summary notifier's `@daily` run) would only ever pay the extra
// `listComments` call for no throttling benefit — consecutive runs are
// already far enough apart that a real streak can't pile up same-window
// comments — so such a notifier passes `renotifyIntervalMs: 0` in its
// FailureNotifierConfig instead of reusing this constant, which skips the
// throttle computation (and the `listComments` call) entirely.
export const RENOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Takes a required epoch-ms timestamp rather than `number | undefined` — the
// caller (notify() below) already has to narrow the undefined case for
// TypeScript to accept indexing into it for the log line, so this stays a
// single guard at the one call site instead of two.
function isWithinRenotifyWindow(
  lastNotifiedAtMs: number,
  renotifyIntervalMs: number,
): boolean {
  const elapsedMs = Date.now() - lastNotifiedAtMs;
  // elapsedMs can go slightly negative if GitHub stamps a timestamp ahead of
  // this container's own (NTP-skewed) clock; treated as "not within the
  // window" (comment/create fires) rather than as "infinitely within it" —
  // the safe direction is an extra notification, not a silently swallowed
  // one.
  return elapsedMs >= 0 && elapsedMs < renotifyIntervalMs;
}

// The issues list endpoint returns pull requests alongside issues, and the
// label filter alone matches anything tagged with that label for an
// unrelated reason (a PR, or an issue someone mislabeled during triage).
// Requiring the marker in the body narrows this to issues a notifier itself
// opened.
function isTrackedFailureIssue(
  issueOrPullRequest: GithubIssueOrPullRequest,
  issueMarker: string,
): boolean {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(issueMarker)
  );
}

// A comment counts as a notifier's own only if it carries the same marker
// the notifier stamps into every issue body and "still failing" comment it
// writes, as the *first* line specifically — mirrors isTrackedFailureIssue's
// reasoning above (a human reply or an unrelated bot comment must not be
// mistaken for a prior notification), but checking `startsWith` rather than
// `includes` also rules out GitHub's "Quote reply", which copies the quoted
// body verbatim (HTML comments included) with each line prefixed by `> `.
// Without this distinction, a maintainer quoting the notifier's own comment
// to reply "on it" would itself look like a fresh notification and
// reintroduce the exact bug this throttle rework fixes (see #139): unrelated
// human activity silencing the notifier.
function isNotifierComment(
  comment: GithubComment,
  issueMarker: string,
): boolean {
  return (comment.body ?? "").startsWith(issueMarker);
}

// GitHub's per-issue comments endpoint returns oldest-first with no
// sort/direction override; `listComments` narrows the request with `since`
// (the throttle window) so an unfiltered page 1 doesn't get stuck showing
// only the oldest matches, but page 1 within that window can still miss a
// recent comment if the issue receives more than LIST_PAGE_SIZE comments
// inside a single renotifyIntervalMs window. That's an extreme, essentially
// pathological rate for a multi-hour throttle to be exercised against — and
// if it happens, this fails open (falls back to `issue.created_at`, so the
// notifier re-comments), which is the safe direction: an extra "still
// failing" comment on an already-noisy issue, not a silently missed one.
function resolveLastNotifiedAt(
  issue: GithubIssueOrPullRequest,
  comments: GithubComment[],
  issueMarker: string,
): number | undefined {
  const notifierCommentTimestampsMs = comments
    .filter((comment) => isNotifierComment(comment, issueMarker))
    .map((comment) => Date.parse(comment.created_at ?? ""))
    .filter((timestampMs) => !Number.isNaN(timestampMs));
  if (notifierCommentTimestampsMs.length === 0) {
    // No (parseable) comment from this notifier yet — the issue's own
    // creation (which this notifier performed, and which already carries
    // the marker) is the most recent notification.
    const issueCreatedAtMs = Date.parse(issue.created_at ?? "");
    return Number.isNaN(issueCreatedAtMs) ? undefined : issueCreatedAtMs;
  }
  return Math.max(...notifierCommentTimestampsMs);
}

// Reuses the issue-body marker rather than a second constant: both mean the
// same thing ("this notifier authored this"), just on different GitHub
// objects (issue vs. comment). Carrying it into every "still failing"
// comment is what lets resolveLastNotifiedAt above tell a notifier's own
// comments apart from a human's "looking into this" reply when it lists
// comments on the failure path.
export function buildStillFailingCommentBody(
  issueMarker: string,
  errorMessage: string,
): string {
  return [
    issueMarker,
    `Still failing. Latest error: ${sanitizeReportedError(errorMessage)}`,
  ].join("\n");
}

export type FailureNotifier = {
  notify(_errorMessage: string): Promise<void>;
};

// What distinguishes one concrete notifier (prune, summary, ...) from
// another: everything else in createFailureNotifier below is identical
// duplicate-guard/throttle mechanics.
export type FailureNotifierConfig = {
  trackingLabel: string;
  issueTitle: string;
  issueMarker: string;
  buildIssueBody(_errorMessage: string): string;
  // Distinct per notifier so a grep for one Function's throttle log doesn't
  // also turn up the other's. Optional because a notifier that disables the
  // throttle entirely (renotifyIntervalMs: 0) can never reach the throttled
  // branch that would log it — omitted rather than a marker that's provably
  // dead code.
  throttledLogPrefix?: string;
  // How long a notifier's own last comment (or the tracked issue's creation,
  // before any comment exists) suppresses a re-comment for — see the
  // comment on RENOTIFY_INTERVAL_MS above for why this is per-notifier
  // rather than a single shared constant. 0 disables the throttle entirely.
  renotifyIntervalMs: number;
};

// Isolates the whole throttle decision (including its own `listComments`
// call and throttled-path logging) so notify() below stays a flat
// list/decide/act sequence instead of nesting the throttle check inside the
// "existing issue" branch.
//
// A notifier that disables the throttle (renotifyIntervalMs: 0, e.g. the
// daily summary notifier) always returns false — skipping the
// `listComments` call and its bookkeeping entirely rather than paying for a
// lookup whose result can never matter.
async function isRenotifyThrottled(
  client: GithubIssuesClient,
  config: FailureNotifierConfig,
  existingIssue: GithubIssueOrPullRequest,
): Promise<boolean> {
  if (config.renotifyIntervalMs <= 0) {
    return false;
  }
  // Computed here (domain policy — the throttle window) rather than inside
  // the adapter, so a fake GithubIssuesClient in tests can observe and honor
  // the same window the real one does instead of the adapter silently
  // deciding it out of the fake's reach.
  const sinceIso = new Date(
    Date.now() - config.renotifyIntervalMs,
  ).toISOString();
  const comments = await client.listComments(existingIssue.number, sinceIso);
  const lastNotifiedAtMs = resolveLastNotifiedAt(
    existingIssue,
    comments,
    config.issueMarker,
  );
  if (lastNotifiedAtMs === undefined) {
    return false;
  }
  if (!isWithinRenotifyWindow(lastNotifiedAtMs, config.renotifyIntervalMs)) {
    return false;
  }
  // Otherwise a throttled run leaves zero trace anywhere: the caller only
  // logs on the underlying failure, not on this deliberate no-op, so a real
  // failure whose only visible effect was "notify did nothing" would be
  // indistinguishable from a notifier that silently broke. throttledLogPrefix
  // is only actually optional in the type — every notifier with a non-zero
  // renotifyIntervalMs (the only way to reach this line) supplies one.
  if (config.throttledLogPrefix) {
    console.log(
      config.throttledLogPrefix,
      JSON.stringify({
        issue: existingIssue.number,
        lastNotifiedAt: new Date(lastNotifiedAtMs).toISOString(),
      }),
    );
  }
  return true;
}

// Pure factory: given anything that can list/create/comment on GitHub
// issues, returns a notifier with the same one-open-issue-per-failure-streak
// behavior as notify-audit-failure.cjs. Left unguarded (no try/catch)
// deliberately, same as that script: a failure here must surface loudly to
// the caller rather than be swallowed, since a silently-broken notifier is
// exactly the failure mode this feature exists to prevent. (The Netlify
// Function that calls this still wraps the call in its own try/catch so a
// broken notifier can't mask the underlying failure it's reporting.)
export function createFailureNotifier(
  client: GithubIssuesClient,
  config: FailureNotifierConfig,
): FailureNotifier {
  return {
    async notify(errorMessage) {
      const openIssues = await client.listOpenIssuesByLabel(
        config.trackingLabel,
      );
      const existingIssue = openIssues.find((issue) =>
        isTrackedFailureIssue(issue, config.issueMarker),
      );
      if (!existingIssue) {
        await client.createIssue({
          title: config.issueTitle,
          labels: [config.trackingLabel],
          body: config.buildIssueBody(errorMessage),
        });
        return;
      }
      if (await isRenotifyThrottled(client, config, existingIssue)) {
        return;
      }
      await client.createComment(
        existingIssue.number,
        buildStillFailingCommentBody(config.issueMarker, errorMessage),
      );
    },
  };
}

// The concrete adapter: talks to the GitHub REST API over `fetch`,
// authenticated with a PAT. This is the only place that touches `fetch`/the
// GitHub API directly, mirroring getCspReportStore()/getCspReportPruner() as
// the only place each touches `@netlify/blobs`.
const GITHUB_API_BASE = "https://api.github.com";
const REPO_OWNER = "neonpixels-studio";
const REPO_NAME = "neonpixels";

// Fine-grained PAT, scoped to this repo's Issues: write permission only, set
// as a Netlify site environment variable (see README). Not required for the
// underlying scheduled Function to run — only for a failure-notification
// path to reach GitHub; a missing/invalid token surfaces as a caught,
// logged `*-notify-failed` marker rather than blocking the 500 response the
// caller already returns for the underlying failure. Named for the first
// notifier that needed it (prune); shared as-is by every notifier built on
// this module rather than renamed, since the token's actual scope (Issues:
// write on this repo) was never prune-specific and renaming would require a
// matching Netlify site config change with no functional benefit.
export const GITHUB_TOKEN_ENV_VAR = "PRUNE_FAILURE_GITHUB_TOKEN";

// Derived from `fetch`'s own signature rather than the bare `RequestInit`
// type name: `RequestInit` is a lib.dom.d.ts *type*, not a runtime global,
// and this repo's ESLint config runs the base (non-type-aware) `no-undef`
// rule, which can't tell a type position from a value reference and flags
// it as an undefined global. Deriving the type from `fetch` sidesteps that
// without a rule exception.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

async function githubRequest(path: string, init: FetchInit): Promise<Response> {
  const token = process.env[GITHUB_TOKEN_ENV_VAR];
  if (!token) {
    throw new Error(`${GITHUB_TOKEN_ENV_VAR} is not set`);
  }
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      // GitHub's REST API requires a User-Agent and rejects requests
      // without one (403). actions/github-script's Octokit client sets this
      // automatically; this module talks to `fetch` directly, so it must
      // set one explicitly rather than rely on the Netlify runtime's
      // default.
      "User-Agent": "neonpixels-csp-report-failure-notifier",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    // Capped the same as a reported failure error (MAX_REPORTED_ERROR_LENGTH):
    // an unexpected non-JSON error page (e.g. a proxy/edge 502) can be many
    // kilobytes, and this message ends up as a single console.warn line in
    // the caller's notify-quietly wrapper — uncapped, it would bury the
    // failure marker that precedes it in the Function logs.
    const body = (await response.text()).slice(0, MAX_REPORTED_ERROR_LENGTH);
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`,
    );
  }
  return response;
}

// `response.json()` throws its own raw SyntaxError on a non-JSON 200 body
// (e.g. an HTML error page from a proxy in front of the real API) — wrapped
// here so every caller gets the same clear "GitHub API" error instead of a
// parser exception with no indication of which request produced it.
async function parseJson(
  response: Response,
  context: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API ${context} response was not valid JSON`);
  }
}

// GitHub silently drops labels the token doesn't have permission to apply
// instead of erroring — if that happened after createIssue's POST, the
// duplicate guard's only entry point (listOpenIssuesByLabel, filtered by
// the tracking label requested in `input.labels`) would never see the
// issue again, and every subsequent failure would open a fresh, unlabeled
// duplicate instead of finding this one. The issue already exists by the
// time this runs (the create call already succeeded), so simply throwing
// on a missing label would itself cause the flood it's trying to prevent —
// orphaning an unlabeled issue every run. This retries attaching the
// originally-requested labels directly, and only throws (naming the
// orphaned issue number, so it's findable) if that retry also fails.
async function attachLabels(
  issueNumber: number,
  labels: string[],
): Promise<void> {
  // The `try` covers only the request itself, not the drain below: by the
  // time the POST resolves, the label is already applied on GitHub's side,
  // so a stream error while draining the (unused) response body must not
  // be mistaken for the attach itself having failed — that would
  // misreport a successfully-delivered notification as broken and send a
  // human chasing the wrong system.
  let labelResponse: Response;
  try {
    labelResponse = await githubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/labels`,
      { method: "POST", body: JSON.stringify({ labels }) },
    );
  } catch (labelAttachError) {
    throw new Error(
      `GitHub API issue creation did not apply all requested labels (${labels.join(", ")}) to issue #${issueNumber}, and retrying the label attach also failed: ${errorMessage(labelAttachError)}`,
      { cause: labelAttachError },
    );
  }
  // Never inspected, same as createComment's response below — drain it
  // explicitly rather than leaving it unconsumed.
  await labelResponse.body?.cancel();
}

export function createFetchGithubIssuesClient(): GithubIssuesClient {
  return {
    async listOpenIssuesByLabel(label) {
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${LIST_PAGE_SIZE}`,
        { method: "GET" },
      );
      const payload = await parseJson(response, "issues list");
      // A 200 response isn't proof of the expected shape (a malformed/error
      // payload the caller still marked `ok`) — `.find()` on anything else
      // throws a confusing TypeError deep inside the duplicate-guard check
      // instead of a clear "GitHub API" error.
      if (!Array.isArray(payload)) {
        throw new Error("GitHub API issues list response was not an array");
      }
      return payload as GithubIssueOrPullRequest[];
    },
    async createIssue(input) {
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
        { method: "POST", body: JSON.stringify(input) },
      );
      const created = (await parseJson(response, "issue creation")) as {
        number: number;
        labels?: Array<{ name?: string }>;
      };
      const createdLabelNames = new Set(
        (created.labels ?? []).map((label) => label.name),
      );
      const hasAllRequestedLabels = input.labels.every((requestedLabel) =>
        createdLabelNames.has(requestedLabel),
      );
      if (hasAllRequestedLabels) {
        return;
      }
      await attachLabels(created.number, input.labels);
    },
    async createComment(issueNumber, body) {
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/comments`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      // Unlike createIssue, this response body is never inspected — drain it
      // explicitly rather than leaving it unconsumed.
      await response.body?.cancel();
    },
    async listComments(issueNumber, sinceIso) {
      // Scoped to the throttle window (sinceIso, computed by the caller)
      // rather than relying on page-1 ordering: GitHub returns issue
      // comments oldest-first with no sort/direction override, so an
      // unscoped page 1 on a busy issue could permanently miss a genuinely
      // recent comment once the issue passes LIST_PAGE_SIZE comments total.
      // `since` filters server-side instead, so only comments that could
      // possibly matter for the throttle are ever fetched.
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/comments?per_page=${LIST_PAGE_SIZE}&since=${encodeURIComponent(sinceIso)}`,
        { method: "GET" },
      );
      const payload = await parseJson(response, "comments list");
      if (!Array.isArray(payload)) {
        throw new Error("GitHub API comments list response was not an array");
      }
      return payload as GithubComment[];
    },
  };
}
