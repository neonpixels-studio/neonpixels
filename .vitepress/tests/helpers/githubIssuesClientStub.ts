import { vi } from "vitest";

import type {
  GithubIssueOrPullRequest,
  GithubIssuesClient,
} from "../../../netlify/functions/lib/githubFailureNotifier";

// Shared by githubFailureNotifier.test.ts, notifyPruneFailure.test.ts and
// notifySummaryFailure.test.ts — all three build a fake GithubIssuesClient
// and a "this notifier already opened this issue" fixture the same way, so
// this is the one place that shape lives (rule of three).

export type GithubClientStubOptions = {
  existingIssues?: GithubIssueOrPullRequest[];
  listOpenIssuesByLabelImpl?: () => Promise<GithubIssueOrPullRequest[]>;
  createIssueImpl?: () => Promise<void>;
};

export function buildGithubClientStub({
  existingIssues = [],
  listOpenIssuesByLabelImpl,
  createIssueImpl,
}: GithubClientStubOptions = {}): GithubIssuesClient & {
  listOpenIssuesByLabel: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
} {
  return {
    listOpenIssuesByLabel: listOpenIssuesByLabelImpl
      ? vi.fn().mockImplementation(listOpenIssuesByLabelImpl)
      : vi.fn().mockResolvedValue(existingIssues),
    createIssue: createIssueImpl
      ? vi.fn().mockImplementation(createIssueImpl)
      : vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
  };
}

// A tracked issue is one a notifier itself opened: carries the given marker
// in its body (the label alone isn't a reliable match — a PR or an
// unrelated issue could carry it during manual triage). Defaults
// `updated_at` to well outside any real re-notify window so callers testing
// "existing issue → comment" don't have to think about throttling unless
// they're specifically testing it.
export function trackedIssue(
  marker: string,
  number: number,
  updatedAt = "2020-01-01T00:00:00.000Z",
): GithubIssueOrPullRequest {
  return {
    number,
    body: `${marker}\nOriginal failure body.`,
    pull_request: undefined,
    updated_at: updatedAt,
  };
}
