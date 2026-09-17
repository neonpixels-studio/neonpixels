// Hand-written declaration for notify-audit-failure.cjs: the script itself
// stays plain CommonJS because it's loaded at runtime via require() from
// actions/github-script (see .github/workflows/security.yml), not through
// this repo's Vite/TS toolchain, but notifyAuditFailure.test.ts still wants
// static types when importing it.
//
// Declared with `export default` (rather than the more literally-accurate
// CJS `export =`) because the only TypeScript consumer of this file is
// notifyAuditFailure.test.ts via Vite/esbuild's CJS interop, which resolves
// a `module.exports = fn` shape to a default import; the real runtime
// consumer (actions/github-script) uses plain Node require() and never sees
// these types at all. `export =` type-checks correctly for a hypothetical
// Node-resolution consumer but breaks default-import destructuring of the
// attached statics under this repo's `moduleResolution: "bundler"` config,
// which is the only case that actually matters here.

export type GithubIssueOrPullRequest = {
  number: number;
  body?: string;
  pull_request?: unknown;
};

// Shared with close-resolved-audit-failure.d.cts: both scripts call
// `findOpenAuditFailureIssue` against the same stubbed `github.rest.issues`
// surface, so the method signatures below cover the union of what either
// script needs from it. `update` is optional: notify-audit-failure.cjs never
// calls it (only close-resolved-audit-failure.cjs does), so its test stubs
// don't provide one.
export type GithubIssuesClient = {
  listForRepo: (params: {
    owner: string;
    repo: string;
    state: string;
    labels: string;
    per_page: number;
  }) => Promise<{ data: GithubIssueOrPullRequest[] }>;
  create: (params: {
    owner: string;
    repo: string;
    title: string;
    labels: string[];
    body: string;
  }) => Promise<{ data: { number: number } }>;
  createComment: (params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }) => Promise<unknown>;
  update?: (params: {
    owner: string;
    repo: string;
    issue_number: number;
    state: string;
  }) => Promise<unknown>;
};

export type NotifyAuditFailureArgs = {
  github: {
    rest: {
      issues: GithubIssuesClient;
    };
  };
  context: {
    repo: { owner: string; repo: string };
    serverUrl: string;
    runId: number;
  };
  core: {
    info: (message: string) => void;
  };
};

export type FindOpenAuditFailureIssueArgs = {
  github: NotifyAuditFailureArgs["github"];
  owner: string;
  repo: string;
};

declare function notifyAuditFailure(
  args: NotifyAuditFailureArgs,
): Promise<void>;

declare namespace notifyAuditFailure {
  const AUDIT_FAILURE_LABEL: string;
  const ISSUE_TITLE: string;
  const ISSUE_MARKER: string;
  function findOpenAuditFailureIssue(
    args: FindOpenAuditFailureIssueArgs,
  ): Promise<GithubIssueOrPullRequest | undefined>;
}

export default notifyAuditFailure;
