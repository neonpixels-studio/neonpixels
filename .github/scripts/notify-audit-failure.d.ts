// Hand-written declaration for notify-audit-failure.js: the script itself
// stays plain CommonJS because it's loaded at runtime via require() from
// actions/github-script (see .github/workflows/security.yml), not through
// this repo's Vite/TS toolchain, but notifyAuditFailure.test.ts still wants
// static types when importing it.

export type GithubIssueOrPullRequest = {
  number: number;
  pull_request?: unknown;
};

export type NotifyAuditFailureArgs = {
  github: {
    rest: {
      issues: {
        listForRepo: (params: {
          owner: string;
          repo: string;
          state: string;
          labels: string;
        }) => Promise<{ data: GithubIssueOrPullRequest[] }>;
        create: (params: {
          owner: string;
          repo: string;
          title: string;
          labels: string[];
          body: string;
        }) => Promise<{ data: { number: number } }>;
      };
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

declare function notifyAuditFailure(
  args: NotifyAuditFailureArgs,
): Promise<void>;

export default notifyAuditFailure;
