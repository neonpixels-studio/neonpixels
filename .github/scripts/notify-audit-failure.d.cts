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

// The `listForRepo`/`createComment` pair both notify-audit-failure.cjs and
// close-resolved-audit-failure.cjs call through `findOpenAuditFailureIssue(s)`
// and their own recovery/notification comments. Exported on its own (rather
// than folded into one `create`-and-`update`-bearing union) so each script's
// args type only requires the API methods it actually calls: notify never
// calls `update`, close never calls `create`, and a stub missing either
// would otherwise type-check while still throwing at runtime.
export type GithubIssuesLookupClient = {
  listForRepo: (params: {
    owner: string;
    repo: string;
    state: string;
    labels: string;
    per_page: number;
  }) => Promise<{ data: GithubIssueOrPullRequest[] }>;
  createComment: (params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }) => Promise<unknown>;
};

export type NotifyGithubIssuesClient = GithubIssuesLookupClient & {
  create: (params: {
    owner: string;
    repo: string;
    title: string;
    labels: string[];
    body: string;
  }) => Promise<{ data: { number: number } }>;
};

// Shared shape of `context`/`core` across both scripts' args types, so
// close-resolved-audit-failure.d.cts can reuse them instead of redeclaring.
export type AuditWorkflowContext = {
  repo: { owner: string; repo: string };
  serverUrl: string;
  runId: number;
};

export type AuditWorkflowCore = {
  info: (message: string) => void;
};

export type NotifyAuditFailureArgs = {
  github: {
    rest: {
      issues: NotifyGithubIssuesClient;
    };
  };
  context: AuditWorkflowContext;
  core: AuditWorkflowCore;
};

export type FindOpenAuditFailureIssuesArgs = {
  github: { rest: { issues: GithubIssuesLookupClient } };
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
  // Only the plural finder is a public export (see notify-audit-failure.cjs)
  // — the singular helper stays private to that file's own duplicate guard.
  function findOpenAuditFailureIssues(
    args: FindOpenAuditFailureIssuesArgs,
  ): Promise<GithubIssueOrPullRequest[]>;
}

export default notifyAuditFailure;
