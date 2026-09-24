import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createSummaryFailureNotifier,
  getSummaryFailureNotifier,
  sanitizeReportedError,
  SUMMARY_FAILURE_LABEL,
  SUMMARY_FAILURE_ISSUE_TITLE,
  SUMMARY_FAILURE_ISSUE_MARKER,
  NOTIFY_THROTTLED_LOG_PREFIX,
  type GithubIssueOrPullRequest,
  type GithubIssuesClient,
} from "../../../netlify/functions/lib/notifySummaryFailure";
import {
  GITHUB_TOKEN_ENV_VAR,
  RENOTIFY_INTERVAL_MS,
} from "../../../netlify/functions/lib/githubFailureNotifier";

// createSummaryFailureNotifier's duplicate-guard logic is the same
// createFailureNotifier factory the prune notifier uses (see
// githubFailureNotifier.ts and notifyPruneFailure.test.ts) — this file
// exercises it configured for a summary failure instead, against a fake
// GithubIssuesClient.

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
    body: `${SUMMARY_FAILURE_ISSUE_MARKER}\nOriginal failure body.`,
    pull_request: undefined,
    updated_at: updatedAt,
  };
}

describe("createSummaryFailureNotifier", () => {
  it("creates an issue when no open summary-failure issue exists", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const [createArgs] = client.createIssue.mock.calls[0];
    expect(createArgs.title).toBe(SUMMARY_FAILURE_ISSUE_TITLE);
    expect(createArgs.labels).toEqual([SUMMARY_FAILURE_LABEL]);
    expect(createArgs.body).toContain(SUMMARY_FAILURE_ISSUE_MARKER);
    expect(createArgs.body).toContain("blobs unavailable");
  });

  it("looks up existing issues by the summary-failure label", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(
      SUMMARY_FAILURE_LABEL,
    );
  });

  it("comments on an existing open summary-failure issue instead of opening a duplicate", async () => {
    const client = buildGithubClientStub({ existingIssues: [trackedIssue(7)] });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("timeout exceeded");

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
    const [issueNumber, body] = client.createComment.mock.calls[0];
    expect(issueNumber).toBe(7);
    expect(body).toContain("timeout exceeded");
  });

  // The issues list endpoint returns pull requests alongside issues. A PR
  // that happens to carry the summary-failure label (e.g. tagged for
  // unrelated triage) must not be mistaken for an existing notification and
  // permanently suppress real ones.
  it("ignores pull requests carrying the summary-failure label", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: SUMMARY_FAILURE_ISSUE_MARKER, pull_request: {} },
      ],
    });
    const notifier = createSummaryFailureNotifier(client);

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
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("does not throw when an issue has no body at all", async () => {
    const client = buildGithubClientStub({
      existingIssues: [{ number: 6, pull_request: undefined }],
    });
    const notifier = createSummaryFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).resolves.toBeUndefined();
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("creates an issue when only a pull request matches but no real issue does", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: SUMMARY_FAILURE_ISSUE_MARKER, pull_request: {} },
        trackedIssue(8),
      ],
    });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    // The real issue (#8) is the match; the PR (#3) must not mask it.
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
  });

  // Fail-loud: a broken notifier (bad token, disabled issues, transient API
  // error) should surface to the caller instead of being swallowed here —
  // the Netlify Function's own catch block is what decides how to log a
  // failure of the notifier itself (see cspReportSummaryFunction.test.ts).
  it("propagates an error from the duplicate check instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      listOpenIssuesByLabelImpl: () =>
        Promise.reject(new Error("API unavailable")),
    });
    const notifier = createSummaryFailureNotifier(client);

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
    const notifier = createSummaryFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issues disabled",
    );
  });

  // Symmetric with the issue-creation case above: a locked/archived tracked
  // issue rejecting the comment call must reject out of notify() too, so
  // the handler logs csp-report-summary-notify-failed rather than treating a
  // failed comment as a delivered notification.
  it("propagates an error from commenting instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      existingIssues: [trackedIssue(7)],
    });
    client.createComment.mockRejectedValueOnce(new Error("issue locked"));
    const notifier = createSummaryFailureNotifier(client);

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issue locked",
    );
  });

  // The summary run is daily; without a throttle, a multi-day failure streak
  // would pile up one near-identical "still failing" comment per run and
  // bury the original diagnosis. Pinned against RENOTIFY_INTERVAL_MS itself
  // (rather than "now" vs. a fixed 2020 date) so the assertion actually
  // fails if the interval changes — a fixed pair of timestamps would still
  // pass for any interval from roughly a second to several years.
  const JUST_INSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS - 60_000;
  const JUST_OUTSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS + 60_000;

  it("does not re-comment on a tracked issue updated just inside the re-notify window, and logs the throttle", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = buildGithubClientStub({
      existingIssues: [
        trackedIssue(
          7,
          new Date(Date.now() - JUST_INSIDE_WINDOW_MS).toISOString(),
        ),
      ],
    });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
    // Without this, the throttled path is silent: the handler only logs on
    // summary failure, so a deliberate no-op and a silently-broken notifier
    // would otherwise be indistinguishable in the logs.
    expect(consoleLogSpy).toHaveBeenCalledWith(
      NOTIFY_THROTTLED_LOG_PREFIX,
      expect.stringContaining('"issue":7'),
    );
    consoleLogSpy.mockRestore();
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
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).toHaveBeenCalledTimes(1);
  });

  it("comments when the tracked issue has no updated_at at all", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        {
          number: 7,
          body: SUMMARY_FAILURE_ISSUE_MARKER,
          pull_request: undefined,
        },
      ],
    });
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("getSummaryFailureNotifier", () => {
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
    const notifier = getSummaryFailureNotifier();

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
          JSON.stringify([{ number: 7, body: SUMMARY_FAILURE_ISSUE_MARKER }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const notifier = getSummaryFailureNotifier();

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
      `labels=${encodeURIComponent(SUMMARY_FAILURE_LABEL)}`,
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
            labels: [{ name: SUMMARY_FAILURE_LABEL }],
          }),
          { status: 201 },
        ),
      );
    const notifier = getSummaryFailureNotifier();

    await notifier.notify("blobs unavailable");

    expect(fetch).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(createUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues",
    );
    expect(createInit?.method).toBe("POST");
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toEqual({
      title: SUMMARY_FAILURE_ISSUE_TITLE,
      labels: [SUMMARY_FAILURE_LABEL],
      body: expect.stringContaining(SUMMARY_FAILURE_ISSUE_MARKER),
    });
    expect((createInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  // GitHub silently drops labels the token can't apply instead of erroring.
  // If that happened here, the duplicate guard (which filters
  // listOpenIssuesByLabel by this exact label) would never see the issue
  // again, and every subsequent failure would open a fresh duplicate rather
  // than finding this one. The issue already exists once this is detected,
  // so a bare throw would itself orphan an unlabeled issue every run —
  // retrying the label attach directly is what actually prevents the flood.
  it("retries attaching the label when GitHub creates the issue without it", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42, labels: [] }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    const notifier = getSummaryFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(3);
    const [labelUrl, labelInit] = vi.mocked(fetch).mock.calls[2];
    expect(String(labelUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues/42/labels",
    );
    expect(labelInit?.method).toBe("POST");
    expect(JSON.parse(labelInit?.body as string)).toEqual({
      labels: [SUMMARY_FAILURE_LABEL],
    });
  });

  it("throws, naming the orphaned issue, when the label-attach retry also fails", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42, labels: [] }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const notifier = getSummaryFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      /did not apply all requested labels .* to issue #42.*label attach also failed/,
    );
  });

  it("throws a descriptive error when the GitHub API responds with a non-OK status", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad credentials", { status: 401 }),
    );
    const notifier = getSummaryFailureNotifier();

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      /GitHub API GET .* failed: 401/,
    );
  });
});

describe("sanitizeReportedError (re-exported from githubFailureNotifier)", () => {
  it("passes short, plain messages through unchanged", () => {
    expect(sanitizeReportedError("blobs unavailable")).toBe(
      "blobs unavailable",
    );
  });
});
