// Hand-written declaration for project-url-check-issue.cjs, which stays plain
// CommonJS because actions/github-script require()s it at runtime; the types
// exist only for project-url-check-issue.test.ts.
export type TrackedIssueOrPullRequest = {
  number: number;
  body?: string;
  pull_request?: unknown;
};

export type ProjectUrlGithub = {
  rest: {
    issues: {
      listForRepo: (params: {
        owner: string;
        repo: string;
        state: string;
        labels: string;
        per_page: number;
      }) => Promise<{ data: TrackedIssueOrPullRequest[] }>;
      create: (params: {
        owner: string;
        repo: string;
        title: string;
        labels: string[];
        body: string;
      }) => Promise<{ data: { number: number } }>;
      update: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        state: string;
      }) => Promise<unknown>;
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
};

export type ProjectUrlContext = {
  repo: { owner: string; repo: string };
  serverUrl: string;
  runId: number;
};

export type ProjectUrlCore = {
  info: (message: string) => void;
  warning: (message: string) => void;
};

export type ProjectUrlScriptArgs = {
  github: ProjectUrlGithub;
  context: ProjectUrlContext;
  core: ProjectUrlCore;
};

export function notifyProjectUrlFailure(
  args: ProjectUrlScriptArgs,
): Promise<void>;
export function closeResolvedProjectUrlFailure(
  args: ProjectUrlScriptArgs,
): Promise<void>;
export const ISSUE_TITLE: string;
export const PROJECT_URL_FAILURE_LABEL: string;
export const ISSUE_MARKER: string;
