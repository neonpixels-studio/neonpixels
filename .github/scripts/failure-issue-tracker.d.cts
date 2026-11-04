// Hand-written declaration for failure-issue-tracker.cjs, which stays plain
// CommonJS because actions/github-script require()s it at runtime.

export type TrackerIssueOrPullRequest = {
  number: number;
  body?: string | null;
  pull_request?: unknown;
};

export type TrackerGithub = {
  rest: {
    issues: {
      listForRepo: (_params: {
        owner: string;
        repo: string;
        state: string;
        labels: string;
        per_page: number;
      }) => Promise<{ data: TrackerIssueOrPullRequest[] }>;
      create: (_params: {
        owner: string;
        repo: string;
        title: string;
        labels: string[];
        body: string;
      }) => Promise<{ data: { number: number } }>;
      update: (_params: {
        owner: string;
        repo: string;
        issue_number: number;
        state: string;
      }) => Promise<unknown>;
      createComment: (_params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
};

export type TrackerContext = {
  repo: { owner: string; repo: string };
  serverUrl: string;
  runId: number;
};

export type TrackerCore = {
  info: (_message: string) => void;
  warning: (_message: string) => void;
};

export type TrackerWorkflowArgs = {
  github: TrackerGithub;
  context: TrackerContext;
  core: TrackerCore;
};

export type FailureIssueTrackerConfig = {
  label: string;
  marker: string;
  title: string;
  logName: string;
  buildIssueBody: (_runUrl: string) => string;
  buildRecoveryComment: (_runUrl: string) => string;
};

export type FailureIssueTracker = {
  findOpenIssues: (_args: {
    github: TrackerGithub;
    owner: string;
    repo: string;
  }) => Promise<TrackerIssueOrPullRequest[]>;
  notify: (_args: TrackerWorkflowArgs) => Promise<void>;
  closeResolved: (_args: TrackerWorkflowArgs) => Promise<void>;
};

export const LIST_PAGE_SIZE: number;

export function createFailureIssueTracker(
  _config: FailureIssueTrackerConfig,
): FailureIssueTracker;
