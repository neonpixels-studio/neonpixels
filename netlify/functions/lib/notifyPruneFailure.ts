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
// the three GitHub calls it needs, so the duplicate-guard logic is
// unit-tested against a fake client instead of the real GitHub API.

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
};

// The three GitHub capabilities the notifier needs, so tests can inject a
// fake without mocking `fetch`/the GitHub API.
export type GithubIssuesClient = {
  listOpenIssuesByLabel(_label: string): Promise<GithubIssueOrPullRequest[]>;
  createIssue(_input: {
    title: string;
    labels: string[];
    body: string;
  }): Promise<{ number: number }>;
  createComment(_issueNumber: number, _body: string): Promise<void>;
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

function buildIssueBody(errorMessage: string): string {
  return [
    PRUNE_FAILURE_ISSUE_MARKER,
    "The hourly csp-report-prune scheduled Function failed.",
    "",
    `Error: ${errorMessage}`,
    "",
    "Check the Netlify Function logs for the full `csp-report-prune-failed` entry.",
    "This issue is a duplicate guard: closing it lets the next failure open a new one.",
  ].join("\n");
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
      if (existingIssue) {
        await client.createComment(
          existingIssue.number,
          `Still failing. Latest error: ${errorMessage}`,
        );
        return;
      }
      await client.createIssue({
        title: PRUNE_FAILURE_ISSUE_TITLE,
        labels: [PRUNE_FAILURE_LABEL],
        body: buildIssueBody(errorMessage),
      });
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
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`,
    );
  }
  return response;
}

function createFetchGithubIssuesClient(): GithubIssuesClient {
  return {
    async listOpenIssuesByLabel(label) {
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${LIST_PAGE_SIZE}`,
        { method: "GET" },
      );
      return (await response.json()) as GithubIssueOrPullRequest[];
    },
    async createIssue(input) {
      const response = await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues`,
        { method: "POST", body: JSON.stringify(input) },
      );
      return (await response.json()) as { number: number };
    },
    async createComment(issueNumber, body) {
      await githubRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/comments`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
    },
  };
}

export function getPruneFailureNotifier(): PruneFailureNotifier {
  return createPruneFailureNotifier(createFetchGithubIssuesClient());
}
