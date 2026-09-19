import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createPruneFailureNotifier,
  getPruneFailureNotifier,
  sanitizeReportedError,
  GITHUB_TOKEN_ENV_VAR,
  PRUNE_FAILURE_LABEL,
  PRUNE_FAILURE_ISSUE_TITLE,
  PRUNE_FAILURE_ISSUE_MARKER,
  RENOTIFY_INTERVAL_MS,
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
  createIssueImpl?: () => Promise<void>;
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
      : vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
  };
}

// A tracked issue is one this notifier itself opened: carries the marker in
// its body (the label alone isn't a reliable match — see the "unrelated
// issue" tests below). Defaults `updated_at` to well outside the re-notify
// throttle window so existing comment tests aren't coupled to it; tests of
// the throttle itself override it explicitly.
function trackedIssue(
  number: number,
  updatedAt = "2020-01-01T00:00:00.000Z",
): GithubIssueOrPullRequest {
  return {
    number,
    body: `${PRUNE_FAILURE_ISSUE_MARKER}\nOriginal failure body.`,
    pull_request: undefined,
    updated_at: updatedAt,
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

  // Symmetric with the issue-creation case above: a locked/archived tracked
  // issue rejecting the comment call must reject out of notify() too, so
  // the handler logs csp-report-prune-notify-failed rather than treating a
  // failed comment as a delivered notification.
  it("propagates an error from commenting instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      existingIssues: [trackedIssue(7)],
    });
    client.createComment.mockRejectedValueOnce(new Error("issue locked"));
    const notifier = createPruneFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issue locked",
    );
  });

  // The pruner runs hourly; without a throttle, a multi-hour failure streak
  // would pile up one near-identical "still failing" comment per run and
  // bury the original diagnosis. Pinned against RENOTIFY_INTERVAL_MS itself
  // (rather than "now" vs. a fixed 2020 date) so the assertion actually
  // fails if the interval changes — a fixed pair of timestamps would still
  // pass for any interval from roughly a second to several years.
  const JUST_INSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS - 60_000;
  const JUST_OUTSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS + 60_000;

  it("does not re-comment on a tracked issue updated just inside the re-notify window", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        trackedIssue(
          7,
          new Date(Date.now() - JUST_INSIDE_WINDOW_MS).toISOString(),
        ),
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("comments again once the tracked issue's last update is just outside the re-notify window", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        trackedIssue(
          7,
          new Date(Date.now() - JUST_OUTSIDE_WINDOW_MS).toISOString(),
        ),
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).toHaveBeenCalledTimes(1);
  });

  it("comments when the tracked issue has no updated_at at all", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        {
          number: 7,
          body: PRUNE_FAILURE_ISSUE_MARKER,
          pull_request: undefined,
        },
      ],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeReportedError", () => {
  it("passes short, plain messages through unchanged", () => {
    expect(sanitizeReportedError("blobs unavailable")).toBe(
      "blobs unavailable",
    );
  });

  it("redacts URLs, which can carry request context or credentials in a query string", () => {
    expect(
      sanitizeReportedError(
        "request to https://blobs.example.com/store?token=secret failed",
      ),
    ).toBe("request to [url redacted] failed");
  });

  it("truncates a message longer than the reported-error cap", () => {
    const longMessage = "x".repeat(1000);

    const sanitized = sanitizeReportedError(longMessage);

    expect(sanitized.length).toBeLessThan(600);
    expect(sanitized).toMatch(/… \(truncated\)$/);
  });

  // A leaked credential is not always inside a URL (e.g. echoed from a
  // header), so this is a second, independent redaction pass rather than
  // relying on the URL pattern above to also catch it.
  it("redacts a bearer-style credential with no URL present", () => {
    expect(
      sanitizeReportedError(
        "Netlify Blobs: request rejected, sent header authorization: Bearer nfp_9x7k2m failed",
      ),
    ).not.toContain("nfp_9x7k2m");
  });

  it("redacts a GitHub-style prefixed token", () => {
    expect(sanitizeReportedError("auth failed for ghp_abcdefghijklmnop")).toBe(
      "auth failed for [secret redacted]",
    );
  });

  // The secret pattern requires a credential-shaped (12+ char) run after
  // "token"/"bearer" specifically so ordinary English isn't mistaken for a
  // credential and redacted into an uninformative issue body — this is the
  // single most likely real prune failure message (an expired/invalid PAT).
  it("does not redact ordinary English containing the word token or bearer", () => {
    expect(sanitizeReportedError("token expired")).toBe("token expired");
    expect(sanitizeReportedError("auth token is invalid")).toBe(
      "auth token is invalid",
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
    const listUrlString = String(listUrl);
    expect(listUrlString).toContain(
      "/repos/neonpixels-studio/neonpixels/issues",
    );
    // The duplicate-guard mechanism lives entirely in this query string —
    // asserting only that the URL contains the base path would still pass
    // if state/labels/per_page were dropped.
    expect(listUrlString).toContain("state=open");
    expect(listUrlString).toContain(
      `labels=${encodeURIComponent(PRUNE_FAILURE_LABEL)}`,
    );
    expect(listUrlString).toContain("per_page=100");
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

  // The "authenticates both GitHub API requests" test above only exercises
  // the comment branch (a tracked issue already exists) — this covers the
  // other branch through the real fetch adapter: opening a brand-new issue,
  // which is the primary path on the first failure of a streak.
  it("opens a new issue through the real fetch adapter when no tracked issue exists", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            labels: [{ name: PRUNE_FAILURE_LABEL }],
          }),
          { status: 201 },
        ),
      );
    const notifier = getPruneFailureNotifier();

    await notifier.notify("blobs unavailable");

    expect(fetch).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(createUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues",
    );
    expect(createInit?.method).toBe("POST");
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toEqual({
      title: PRUNE_FAILURE_ISSUE_TITLE,
      labels: [PRUNE_FAILURE_LABEL],
      body: expect.stringContaining(PRUNE_FAILURE_ISSUE_MARKER),
    });
    expect((createInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  // GitHub silently drops labels the token can't apply instead of erroring.
  // If that happened here, the duplicate guard (which filters
  // listOpenIssuesByLabel by this exact label) would never see the issue
  // again, and every subsequent failure would open a fresh duplicate rather
  // than finding this one — so a missing label must fail loudly instead.
  it("throws when GitHub creates the issue without the tracking label", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42, labels: [] }), {
          status: 201,
        }),
      );
    const notifier = getPruneFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      `did not apply the ${PRUNE_FAILURE_LABEL} label`,
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

  it("truncates a large non-OK error body instead of dumping it whole into the thrown message", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("x".repeat(10000), { status: 502 }),
    );
    const notifier = getPruneFailureNotifier();

    const error = await notifier
      .notify("blobs unavailable")
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(Error);
    // The message is "GitHub API GET <path> failed: 502 " (prefix overhead)
    // plus the capped body — well under the raw 10000-character response.
    expect((error as Error).message.length).toBeLessThan(700);
  });

  // A 200 with a body that isn't valid JSON (e.g. an HTML error page from a
  // proxy in front of the real API) must surface as a clear "GitHub API"
  // error, not a raw, unattributed SyntaxError from response.json() itself.
  it("throws a descriptive error when a 200 response isn't valid JSON", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );
    const notifier = getPruneFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "GitHub API issues list response was not valid JSON",
    );
  });

  it("throws a descriptive error when the issues list response is valid JSON but not an array", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 200,
      }),
    );
    const notifier = getPruneFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "GitHub API issues list response was not an array",
    );
  });
});
