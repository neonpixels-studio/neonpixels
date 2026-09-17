import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createPruneFailureNotifier,
  getPruneFailureNotifier,
  GITHUB_TOKEN_ENV_VAR,
  PRUNE_FAILURE_LABEL,
  PRUNE_FAILURE_ISSUE_TITLE,
  PRUNE_FAILURE_ISSUE_MARKER,
  type GithubIssueOrPullRequest,
  type GithubIssuesClient,
} from "../../../netlify/functions/lib/notifyPruneFailure";

// createPruneFailureNotifier's duplicate-guard logic mirrors
// notify-audit-failure.cjs (see notifyAuditFailure.test.ts) — this file
// exercises the same behaviors against a fake GithubIssuesClient instead of
// a stubbed Octokit `github` object, since this notifier talks to the
// GitHub REST API over `fetch` rather than through actions/github-script.

type GithubStubOptions = {
  existingIssues?: GithubIssueOrPullRequest[];
  listOpenIssuesByLabelImpl?: () => Promise<GithubIssueOrPullRequest[]>;
  createIssueImpl?: () => Promise<{ number: number }>;
};

function buildGithubClientStub({
  existingIssues = [],
  listOpenIssuesByLabelImpl,
  createIssueImpl,
}: GithubStubOptions = {}): GithubIssuesClient & {
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
      : vi.fn().mockResolvedValue({ number: 99 }),
    createComment: vi.fn().mockResolvedValue(undefined),
  };
}

// A tracked issue is one this notifier itself opened: carries the marker in
// its body (the label alone isn't a reliable match — see the "unrelated
// issue" tests below).
function trackedIssue(number: number): GithubIssueOrPullRequest {
  return {
    number,
    body: `${PRUNE_FAILURE_ISSUE_MARKER}\nOriginal failure body.`,
    pull_request: undefined,
  };
}

describe("createPruneFailureNotifier", () => {
  it("creates an issue when no open prune-failure issue exists", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const [createArgs] = client.createIssue.mock.calls[0];
    expect(createArgs.title).toBe(PRUNE_FAILURE_ISSUE_TITLE);
    expect(createArgs.labels).toEqual([PRUNE_FAILURE_LABEL]);
    expect(createArgs.body).toContain(PRUNE_FAILURE_ISSUE_MARKER);
    expect(createArgs.body).toContain("blobs unavailable");
  });

  it("looks up existing issues by the prune-failure label", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(
      PRUNE_FAILURE_LABEL,
    );
  });

  it("comments on an existing open prune-failure issue instead of opening a duplicate", async () => {
    const client = buildGithubClientStub({ existingIssues: [trackedIssue(7)] });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("timeout exceeded");

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
    const [issueNumber, body] = client.createComment.mock.calls[0];
    expect(issueNumber).toBe(7);
    expect(body).toContain("timeout exceeded");
  });

  // The issues list endpoint returns pull requests alongside issues. A PR
  // that happens to carry the prune-failure label (e.g. tagged for unrelated
  // triage) must not be mistaken for an existing notification and
  // permanently suppress real ones.
  it("ignores pull requests carrying the prune-failure label", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: PRUNE_FAILURE_ISSUE_MARKER, pull_request: {} },
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  // The label alone isn't a reliable match — an unrelated issue could carry
  // it during manual triage. Only an issue whose body carries this
  // notifier's marker should suppress a new notification.
  it("ignores an open issue with the label but no marker in its body", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 5, body: "Unrelated issue.", pull_request: undefined },
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("does not throw when an issue has no body at all", async () => {
    const client = buildGithubClientStub({
      existingIssues: [{ number: 6, pull_request: undefined }],
    });
    const notifier = createPruneFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).resolves.toBeUndefined();
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("creates an issue when only a pull request matches but no real issue does", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: PRUNE_FAILURE_ISSUE_MARKER, pull_request: {} },
        trackedIssue(8),
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    // The real issue (#8) is the match; the PR (#3) must not mask it.
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
  });

  // Fail-loud: a broken notifier (bad token, disabled issues, transient API
  // error) should surface to the caller instead of being swallowed here —
  // the Netlify Function's own catch block is what decides how to log a
  // failure of the notifier itself (see cspReportPruneFunction.test.ts).
  it("propagates an error from the duplicate check instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      listOpenIssuesByLabelImpl: () =>
        Promise.reject(new Error("API unavailable")),
    });
    const notifier = createPruneFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "API unavailable",
    );
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("propagates an error from issue creation instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      existingIssues: [],
      createIssueImpl: () => Promise.reject(new Error("issues disabled")),
    });
    const notifier = createPruneFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issues disabled",
    );
  });
});

describe("getPruneFailureNotifier", () => {
  const ORIGINAL_TOKEN = process.env[GITHUB_TOKEN_ENV_VAR];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env[GITHUB_TOKEN_ENV_VAR];
    } else {
      process.env[GITHUB_TOKEN_ENV_VAR] = ORIGINAL_TOKEN;
    }
  });

  it("rejects instead of calling GitHub when the token env var is unset", async () => {
    delete process.env[GITHUB_TOKEN_ENV_VAR];
    const notifier = getPruneFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      `${GITHUB_TOKEN_ENV_VAR} is not set`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates both GitHub API requests with the configured token and hits the right endpoints", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ number: 7, body: PRUNE_FAILURE_ISSUE_MARKER }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const notifier = getPruneFailureNotifier();

    await notifier.notify("blobs unavailable");

    expect(fetch).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = vi.mocked(fetch).mock.calls[0];
    expect(String(listUrl)).toContain(
      "/repos/neonpixels-studio/neonpixels/issues",
    );
    expect((listInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    const [commentUrl, commentInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(commentUrl)).toContain(
      "/repos/neonpixels-studio/neonpixels/issues/7/comments",
    );
    expect((commentInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("throws a descriptive error when the GitHub API responds with a non-OK status", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad credentials", { status: 401 }),
    );
    const notifier = getPruneFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      /GitHub API GET .* failed: 401/,
    );
  });
});
