// GitHub issue notifier for a failed csp-report-prune run. Mirrors the
// duplicate-guard behavior in .github/scripts/notify-audit-failure.cjs (find
// an open, marker-tagged issue and comment on it; otherwise open a new one)
// so a failing prune run is surfaced the same way a failing scheduled audit
// run already is — see issue #123. That script authenticates via
// actions/github-script's built-in Octokit client, which only exists inside
// a GitHub Actions job; this module runs inside a Netlify Function instead,
// where no such client is available, so it talks to the GitHub REST API
// directly over `fetch`. The two aren't shared code (one is CommonJS loaded
// by actions/github-script, the other TypeScript bundled into the Netlify
// Function), but they deliberately encode the same duplicate-guard shape —
// label + body-marker match, comment on an existing tracked issue instead of
// opening a duplicate — so a human who has read one recognizes the other.
//
// Isolated behind GithubIssuesClient the same way cspReportStore.ts isolates
// Blobs writes (BlobWriter) and cspReportPruner.ts isolates list/delete
// (BlobPrunerClient): createPruneFailureNotifier takes anything shaped like
// the four GitHub calls it needs, so the duplicate-guard logic is
// unit-tested against a fake client instead of the real GitHub API.

// Named like the other log markers in this feature (PRUNE_FAILED_LOG_PREFIX
// etc. in csp-report-prune.ts) rather than an inline literal, and exported
// so notifyPruneFailure.test.ts can assert against it directly.
export const NOTIFY_THROTTLED_LOG_PREFIX = "csp-report-prune-notify-throttled";

export const PRUNE_FAILURE_LABEL = "csp-prune-failure";
export const PRUNE_FAILURE_ISSUE_TITLE =
  "Scheduled csp-report-prune Function failed";

// Invisible in rendered Markdown, and written into the issue body rather
// than the title, for the same reason notify-audit-failure.cjs does this: a
// title is fair game for a human to edit during triage, which would break a
// title-based match on the next failure; the body marker survives that.
export const PRUNE_FAILURE_ISSUE_MARKER =
  "<!-- neonpixels:prune-failure-notifier -->";

// GitHub caps the issues list endpoint at 30 results per page by default;
// 100 is the API's max per_page. Mirrors LIST_PAGE_SIZE in
// notify-audit-failure.cjs for the same reason: a long streak of unrelated
// items carrying this label shouldn't be able to push the real notification
// issue past page 1 and defeat the duplicate guard below.
const LIST_PAGE_SIZE = 100;

export type GithubIssueOrPullRequest = {
  number: number;
  body?: string;
  pull_request?: unknown;
  // Used as the re-notify fallback timestamp below: the notifier's own
  // *first* notification for a failure streak is the moment it opened this
  // issue, so before any of its own comments exist, throttling from here is
  // correct. Once the notifier has posted a comment, that comment's
  // created_at takes over — see resolveLastNotifiedAt.
  created_at?: string;
};

// A single comment on a tracked issue. Only the fields the duplicate-guard
// needs to identify the notifier's own comments and time them.
export type GithubComment = {
  body?: string;
  created_at?: string;
};

// The four GitHub capabilities the notifier needs, so tests can inject a
// fake without mocking `fetch`/the GitHub API.
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
  // issue" path, so it stays off the hot path for a healthy prune run.
  listComments(_issueNumber: number): Promise<GithubComment[]>;
};

// The issues list endpoint returns pull requests alongside issues, and the
// label filter alone matches anything tagged with this label for an
// unrelated reason (a PR, or an issue someone mislabeled during triage).
// Requiring the marker in the body narrows this to issues this notifier
// itself opened.
function isTrackedPruneFailureIssue(
  issueOrPullRequest: GithubIssueOrPullRequest,
): boolean {
  return (
    !issueOrPullRequest.pull_request &&
    (issueOrPullRequest.body ?? "").includes(PRUNE_FAILURE_ISSUE_MARKER)
  );
}

// The pruner catches errors from `@netlify/blobs`/`fetch`/`withTimeout`
// itself, so the error text reported here isn't a closed set — an upstream
// HTTP client can surface request URLs (potentially carrying credentials in
// a query string) in its message. Redacted and length-capped before it's
// published into a GitHub issue body/comment on a repo that may be public.
// The cap also keeps this under GitHub's ~65536-char issue/comment body
// limit — an uncapped message on a large failure would otherwise make the
// notification itself fail (422), which is exactly when it's most needed.
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

function buildIssueBody(errorMessage: string): string {
  return [
    PRUNE_FAILURE_ISSUE_MARKER,
    "The hourly csp-report-prune scheduled Function failed.",
    "",
    `Error: ${sanitizeReportedError(errorMessage)}`,
    "",
    "Check the Netlify Function logs for the full `csp-report-prune-failed` entry.",
    "This issue is a duplicate guard: closing it lets the next failure open a new one.",
  ].join("\n");
}

// Reuses the issue-body marker rather than a second constant: both mean the
// same thing ("this notifier authored this"), just on different GitHub
// objects (issue vs. comment). Carrying it into every "still failing"
// comment is what lets resolveLastNotifiedAt below tell this notifier's own
// comments apart from a human's "looking into this" reply when it lists
// comments on the failure path.
// Exported so notifyPruneFailure.test.ts can build the same shape a real
// notifier comment has (marker included) instead of duplicating the format
// inline, which would let the marker silently drift out of the comment body
// while every test still passes.
export function buildStillFailingCommentBody(errorMessage: string): string {
  return [
    PRUNE_FAILURE_ISSUE_MARKER,
    `Still failing. Latest error: ${sanitizeReportedError(errorMessage)}`,
  ].join("\n");
}

// The pruner runs hourly; without throttling, a failure streak spanning even
// a day would bury the original diagnosis under ~24 near-identical "still
// failing" comments. Re-notify at most this often.
//
// This used to throttle off the issue's `updated_at`, which GitHub bumps on
// *any* activity — a human comment, label change, or edit — not just this
// notifier's own comments. That silenced re-notification for up to
// RENOTIFY_INTERVAL_MS after unrelated human activity even while the
// underlying failure kept changing (see #139). Instead this throttles off
// the created_at of this notifier's own last comment (marked with
// PRUNE_FAILURE_ISSUE_MARKER, same as the issue body — see
// resolveLastNotifiedAt), found via one extra `listComments` call on the
// failure path (an existing tracked issue is already found). That call is
// deliberately confined to the failure path rather than made unconditional:
// a healthy prune run never reaches here at all, and the common failure
// case (first failure of a streak) opens a fresh issue instead of listing
// comments on one.
// Exported so notifyPruneFailure.test.ts can pin the boundary itself,
// rather than only testing with values (e.g. "now" vs. 2020) that would
// pass for any interval between roughly a second and several years.
export const RENOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

function isWithinRenotifyWindow(lastNotifiedAt: string | undefined): boolean {
  if (!lastNotifiedAt) {
    return false;
  }
  const lastNotifiedAtMs = Date.parse(lastNotifiedAt);
  if (Number.isNaN(lastNotifiedAtMs)) {
    return false;
  }
  return Date.now() - lastNotifiedAtMs < RENOTIFY_INTERVAL_MS;
}

// A comment counts as this notifier's own only if it carries the same
// marker the notifier stamps into every issue body and "still failing"
// comment it writes — mirrors isTrackedPruneFailureIssue's reasoning above:
// a human reply or a bot comment from something else entirely must not be
// mistaken for a prior notification and used to compute the throttle.
function isNotifierComment(comment: GithubComment): boolean {
  return (comment.body ?? "").includes(PRUNE_FAILURE_ISSUE_MARKER);
}

// GitHub's per-issue comments endpoint returns oldest-first with no
// sort/direction override — fetching only page 1 (LIST_PAGE_SIZE) with no
// further filter would let a busy issue's oldest comments permanently
// occupy page 1, so a genuinely recent notifier comment could never be
// seen and the throttle would look perpetually stale. `listComments` scopes
// the request with `since` to just the throttle window instead (see the
// fetch adapter below), so only comments recent enough to matter are ever
// fetched — the "which page are they on" question doesn't arise.
function resolveLastNotifiedAt(
  issue: GithubIssueOrPullRequest,
  comments: GithubComment[],
): string | undefined {
  const notifierCommentTimestampsMs = comments
    .filter(isNotifierComment)
    .map((comment) => Date.parse(comment.created_at ?? ""))
    .filter((timestampMs) => !Number.isNaN(timestampMs));
  if (notifierCommentTimestampsMs.length === 0) {
    // No (parseable) comment from this notifier yet — the issue's own
    // creation (which this notifier performed, and which already carries
    // the marker) is the most recent notification.
    return issue.created_at;
  }
  return new Date(Math.max(...notifierCommentTimestampsMs)).toISOString();
}

export type PruneFailureNotifier = {
  notify(_errorMessage: string): Promise<void>;
};

// Pure factory: given anything that can list/create/comment on GitHub
// issues, returns a notifier with the same one-open-issue-per-failure-streak
// behavior as notify-audit-failure.cjs. Left unguarded (no try/catch)
// deliberately, same as that script: a failure here must surface loudly to
// the caller rather than be swallowed, since a silently-broken notifier is
// exactly the failure mode this feature exists to prevent. (The Netlify
// Function that calls this still wraps the call in its own try/catch so a
// broken notifier can't mask the underlying prune failure it's reporting.)
export function createPruneFailureNotifier(
  client: GithubIssuesClient,
): PruneFailureNotifier {
  return {
    async notify(errorMessage) {
      const openIssues =
        await client.listOpenIssuesByLabel(PRUNE_FAILURE_LABEL);
      const existingIssue = openIssues.find(isTrackedPruneFailureIssue);
      if (!existingIssue) {
        await client.createIssue({
          title: PRUNE_FAILURE_ISSUE_TITLE,
          labels: [PRUNE_FAILURE_LABEL],
          body: buildIssueBody(errorMessage),
        });
        return;
      }
      const comments = await client.listComments(existingIssue.number);
      const lastNotifiedAt = resolveLastNotifiedAt(existingIssue, comments);
      if (isWithinRenotifyWindow(lastNotifiedAt)) {
        // Otherwise a throttled run leaves zero trace anywhere: the handler
        // only logs on prune *failure*, not on this deliberate no-op, so a
        // real failure whose only visible effect was "notify did nothing"
        // would be indistinguishable from a notifier that silently broke.
        console.log(
          NOTIFY_THROTTLED_LOG_PREFIX,
          JSON.stringify({
            issue: existingIssue.number,
            lastNotifiedAt,
          }),
        );
        return;
      }
      await client.createComment(
        existingIssue.number,
        buildStillFailingCommentBody(errorMessage),
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
// pruner to run — only for this failure-notification path to reach GitHub;
// a missing/invalid token surfaces as a caught, logged
// `csp-report-prune-notify-failed` marker rather than blocking the 500
// response the pruner already returns for the underlying failure.
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
      "User-Agent": "neonpixels-csp-report-prune-notifier",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    // Capped the same as a reported prune error (MAX_REPORTED_ERROR_LENGTH):
    // an unexpected non-JSON error page (e.g. a proxy/edge 502) can be many
    // kilobytes, and this message ends up as a single console.warn line in
    // notifyPruneFailureQuietly — uncapped, it would bury the
    // csp-report-prune-failed line that precedes it in the Function logs.
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

function createFetchGithubIssuesClient(): GithubIssuesClient {
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
      // GitHub silently drops labels the token doesn't have permission to
      // apply instead of erroring — if that happened here, the duplicate
      // guard's only entry point (listOpenIssuesByLabel, filtered by this
      // same label) would never see this issue again, and every subsequent
      // hourly failure would open a fresh, unlabeled duplicate instead of
      // finding this one. The issue already exists at this point (the
      // create call above already succeeded), so simply throwing here would
      // itself cause the flood it's trying to prevent — orphaning an
      // unlabeled issue every run. Retry attaching the label directly
      // before giving up, and only throw (naming the orphaned issue number,
      // so it's findable) if that retry also fails.
      const hasTrackingLabel = (created.labels ?? []).some(
        (label) => label.name === PRUNE_FAILURE_LABEL,
      );
      if (!hasTrackingLabel) {
        try {
          await githubRequest(
            `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${created.number}/labels`,
            {
              method: "POST",
              body: JSON.stringify({ labels: [PRUNE_FAILURE_LABEL] }),
            },
          );
        } catch (labelAttachError) {
          throw new Error(
            `GitHub API issue creation did not apply the ${PRUNE_FAILURE_LABEL} label to issue #${created.number}, and retrying the label attach also failed: ${labelAttachError instanceof Error ? labelAttachError.message : String(labelAttachError)}`,
            { cause: labelAttachError },
          );
        }
      }
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
    async listComments(issueNumber) {
      // Scoped to the throttle window via `since` rather than relying on
      // page-1 ordering: GitHub returns issue comments oldest-first with no
      // sort/direction override, so an unscoped page 1 on a busy issue could
      // permanently miss a genuinely recent comment once the issue passes
      // LIST_PAGE_SIZE comments total. `since` filters server-side instead,
      // so only comments that could possibly matter for the throttle are
      // ever fetched.
      const since = new Date(Date.now() - RENOTIFY_INTERVAL_MS).toISOString();
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/comments?per_page=${LIST_PAGE_SIZE}&since=${encodeURIComponent(since)}`,
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

export function getPruneFailureNotifier(): PruneFailureNotifier {
  return createPruneFailureNotifier(createFetchGithubIssuesClient());
}
