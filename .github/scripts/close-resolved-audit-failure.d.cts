// Hand-written declaration for close-resolved-audit-failure.cjs, mirroring
// notify-audit-failure.d.cts: the script stays plain CommonJS because it's
// loaded at runtime via require() from actions/github-script (see
// .github/workflows/security.yml), not through this repo's Vite/TS
// toolchain, but closeResolvedAuditFailure.test.ts still wants static types
// when importing it. See notify-audit-failure.d.cts for why `export default`
// is used instead of the more literally-accurate CJS `export =`.

import type {
  GithubIssuesLookupClient,
  AuditWorkflowContext,
  AuditWorkflowCore,
} from "./notify-audit-failure.cjs";

// Its own client type (rather than reusing NotifyGithubIssuesClient) because
// this script's actual dependency is `update`, not `create`: aliasing the
// notify args wholesale would let a stub missing `update` type-check clean
// while still throwing `TypeError: ...update is not a function` at runtime.
//
// The inline parameter name below (and `_args` further down) is prefixed
// with `_` only to satisfy this repo's base-ESLint `no-unused-vars` rule:
// the ambient-declaration carve-out in eslint.config.js is scoped to
// notify-audit-failure.d.cts specifically, and extending it to this file is
// out of scope here (separate in-flight work owns eslint.config.js). These
// are type-signature parameter names, not real unused bindings — base
// ESLint (no TS-aware plugin configured) can't tell the difference.
export type CloseGithubIssuesClient = GithubIssuesLookupClient & {
  update: (_params: {
    owner: string;
    repo: string;
    issue_number: number;
    state: string;
  }) => Promise<unknown>;
};

export type CloseResolvedAuditFailureArgs = {
  github: {
    rest: {
      issues: CloseGithubIssuesClient;
    };
  };
  context: AuditWorkflowContext;
  core: AuditWorkflowCore;
};

declare function closeResolvedAuditFailure(
  _args: CloseResolvedAuditFailureArgs,
): Promise<void>;

export default closeResolvedAuditFailure;
