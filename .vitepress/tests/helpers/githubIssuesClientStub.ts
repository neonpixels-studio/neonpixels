import { vi } from "vitest";

import type {
  GithubComment,
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
  // Comments visible to a fake listComments call, filtered by sinceIso the
  // same way the real fetch adapter's `since` query param would (GitHub
  // still returns a comment with an unparseable created_at rather than
  // excluding it — only resolveLastNotifiedAt's own filtering does that, so
  // a test handing the notifier a comment outside the window is exercising
  // input the real adapter could never actually produce otherwise).
  comments?: GithubComment[];
  listCommentsImpl?: () => Promise<GithubComment[]>;
};

export function buildGithubClientStub({
  existingIssues = [],
  listOpenIssuesByLabelImpl,
  createIssueImpl,
  comments = [],
  listCommentsImpl,
}: GithubClientStubOptions = {}): GithubIssuesClient & {
  listOpenIssuesByLabel: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  listComments: ReturnType<typeof vi.fn>;
} {
  return {
    listOpenIssuesByLabel: listOpenIssuesByLabelImpl
      ? vi.fn().mockImplementation(listOpenIssuesByLabelImpl)
      : vi.fn().mockResolvedValue(existingIssues),
    createIssue: createIssueImpl
      ? vi.fn().mockImplementation(createIssueImpl)
      : vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
    listComments: listCommentsImpl
      ? vi.fn().mockImplementation(listCommentsImpl)
      : vi
          .fn()
          .mockImplementation(async (_issueNumber: number, sinceIso: string) => {
            const sinceMs = Date.parse(sinceIso);
            return comments.filter((comment) => {
              const createdAtMs = Date.parse(comment.created_at ?? "");
              return Number.isNaN(createdAtMs) || createdAtMs >= sinceMs;
            });
          }),
  };
}

// A tracked issue is one a notifier itself opened: carries the given marker
// in its body (the label alone isn't a reliable match — a PR or an
// unrelated issue could carry it during manual triage). Defaults
// `created_at` to well outside any real re-notify window so callers testing
// "existing issue → comment" don't have to think about throttling unless
// they're specifically testing it (with no notifier comments in play,
// resolveLastNotifiedAt falls back to this).
export function trackedIssue(
  marker: string,
  number: number,
  createdAt = "2020-01-01T00:00:00.000Z",
): GithubIssueOrPullRequest {
  return {
    number,
    body: `${marker}\nOriginal failure body.`,
    pull_request: undefined,
    created_at: createdAt,
  };
}
