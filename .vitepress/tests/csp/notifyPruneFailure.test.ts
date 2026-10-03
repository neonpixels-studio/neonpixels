import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createPruneFailureNotifier,
  createPruneFailureResolver,
  getPruneFailureNotifier,
  getPruneFailureResolver,
  PRUNE_RECOVERED_COMMENT,
  RESOLVE_COMMENT_FAILED_LOG_PREFIX,
  PRUNE_FAILURE_LABEL,
  PRUNE_FAILURE_ISSUE_TITLE,
  PRUNE_FAILURE_ISSUE_MARKER,
  NOTIFY_THROTTLED_LOG_PREFIX,
} from "../../../netlify/functions/lib/notifyPruneFailure";
import {
  GITHUB_TOKEN_ENV_VAR,
  type GithubIssueClosingClient,
  type GithubIssueOrPullRequest,
} from "../../../netlify/functions/lib/githubFailureNotifier";
import {
  buildGithubClientStub,
  trackedIssue as trackedIssueWithMarker,
} from "../helpers/githubIssuesClientStub";

// The generic duplicate-guard/throttle mechanics and the fetch-based GitHub
// REST adapter this notifier is built on (createFailureNotifier,
// createFetchGithubIssuesClient) are exercised once, against a throwaway
// config, in githubFailureNotifier.test.ts — this file only covers what's
// specific to a prune failure: the label/title/marker/body
// createPruneFailureNotifier configures, and that getPruneFailureNotifier()
// wires them through to the real adapter. See #123, #137.

function trackedIssue(number: number, createdAt: string) {
  return trackedIssueWithMarker(PRUNE_FAILURE_ISSUE_MARKER, number, createdAt);
}

describe("createPruneFailureNotifier", () => {
  // A test that stubs console.log and then fails its own assertion before
  // reaching a manual mockRestore() would otherwise leave console.log
  // stubbed for every subsequent test in this file — restoring here runs
  // regardless of how the test ends.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an issue labeled/titled/marked for a prune failure, with the error in the body", async () => {
    const client = buildGithubClientStub();
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(
      PRUNE_FAILURE_LABEL,
    );
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const [createArgs] = vi.mocked(client.createIssue).mock.calls[0];
    expect(createArgs.title).toBe(PRUNE_FAILURE_ISSUE_TITLE);
    expect(createArgs.labels).toEqual([PRUNE_FAILURE_LABEL]);
    expect(createArgs.body).toContain(PRUNE_FAILURE_ISSUE_MARKER);
    expect(createArgs.body).toContain("hourly csp-report-prune");
    expect(createArgs.body).toContain("blobs unavailable");
  });

  it("logs the configured throttle prefix when a tracked issue was created inside the re-notify window", async () => {
    // The pruner runs hourly — dense enough that RENOTIFY_INTERVAL_MS
    // actually suppresses a same-streak comment (unlike the summary
    // notifier, which passes renotifyIntervalMs: 0 — see
    // notifySummaryFailure.test.ts). The throttle mechanics themselves are
    // covered generically in githubFailureNotifier.test.ts; this only pins
    // that createPruneFailureNotifier wires its own
    // NOTIFY_THROTTLED_LOG_PREFIX through.
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = buildGithubClientStub({
      existingIssues: [trackedIssue(7, new Date().toISOString())],
    });
    const notifier = createPruneFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      NOTIFY_THROTTLED_LOG_PREFIX,
      expect.stringContaining('"issue":7'),
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

  // The real fetch adapter itself (auth, endpoints, error handling) is
  // covered generically in githubFailureNotifier.test.ts; this only proves
  // getPruneFailureNotifier() wires the prune label/title/marker through to
  // it correctly.
  it("wires the real fetch adapter to the prune label/title/marker when opening a new issue", async () => {
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
    const [listUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(listUrl)).toContain(
      `labels=${encodeURIComponent(PRUNE_FAILURE_LABEL)}`,
    );
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(createUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues",
    );
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toEqual({
      title: PRUNE_FAILURE_ISSUE_TITLE,
      labels: [PRUNE_FAILURE_LABEL],
      body: expect.stringContaining(PRUNE_FAILURE_ISSUE_MARKER),
    });
  });
});

function buildClosingClientStub(
  existingIssues: GithubIssueOrPullRequest[] = [],
) {
  return {
    listOpenIssuesByLabel: vi.fn().mockResolvedValue(existingIssues),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
  } satisfies GithubIssueClosingClient;
}

describe("createPruneFailureResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the open tracked prune-failure issue and leaves a recovery comment", async () => {
    const client = buildClosingClientStub([trackedIssue(7, "2020-01-01")]);

    await createPruneFailureResolver(client).resolve();

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(
      PRUNE_FAILURE_LABEL,
    );
    expect(client.closeIssue).toHaveBeenCalledTimes(1);
    expect(client.closeIssue).toHaveBeenCalledWith(7);
    expect(client.createComment).toHaveBeenCalledWith(
      7,
      PRUNE_RECOVERED_COMMENT,
    );
  });

  it("does nothing beyond the single list call when no tracked issue is open", async () => {
    const client = buildClosingClientStub([]);

    await createPruneFailureResolver(client).resolve();

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(1);
    expect(client.closeIssue).not.toHaveBeenCalled();
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it("ignores labeled pull requests and issues without the notifier marker", async () => {
    const client = buildClosingClientStub([
      { number: 1, body: "unrelated", created_at: "2020-01-01" },
      { ...trackedIssue(2, "2020-01-01"), pull_request: {} },
    ]);

    await createPruneFailureResolver(client).resolve();

    expect(client.closeIssue).not.toHaveBeenCalled();
  });

  it("still closes the other issues when one close fails, then throws naming the failure", async () => {
    const client = buildClosingClientStub([
      trackedIssue(7, "2020-01-01"),
      trackedIssue(8, "2020-01-01"),
    ]);
    client.closeIssue
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await expect(createPruneFailureResolver(client).resolve()).rejects.toThrow(
      "#7: boom",
    );
    expect(client.closeIssue).toHaveBeenCalledWith(8);
    // A failed close must not be followed by a "recovered" comment.
    expect(client.createComment).not.toHaveBeenCalledWith(7, expect.anything());
    expect(client.createComment).toHaveBeenCalledWith(
      8,
      PRUNE_RECOVERED_COMMENT,
    );
  });

  it("logs, rather than throws, when the recovery comment fails after a successful close", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = buildClosingClientStub([trackedIssue(7, "2020-01-01")]);
    client.createComment.mockRejectedValueOnce(new Error("comment down"));

    await expect(
      createPruneFailureResolver(client).resolve(),
    ).resolves.toBeUndefined();

    expect(client.closeIssue).toHaveBeenCalledWith(7);
    expect(warn).toHaveBeenCalledWith(
      RESOLVE_COMMENT_FAILED_LOG_PREFIX,
      expect.stringContaining("comment down"),
    );
  });

  it("propagates a failed lookup instead of swallowing it", async () => {
    const client = buildClosingClientStub();
    client.listOpenIssuesByLabel.mockRejectedValueOnce(new Error("api down"));

    await expect(createPruneFailureResolver(client).resolve()).rejects.toThrow(
      "api down",
    );
  });
});

describe("getPruneFailureResolver", () => {
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

  it("rejects without calling GitHub when the token is not set", async () => {
    delete process.env[GITHUB_TOKEN_ENV_VAR];

    await expect(getPruneFailureResolver().resolve()).rejects.toThrow(
      GITHUB_TOKEN_ENV_VAR,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wires the real fetch adapter to list by label, PATCH the issue closed, and comment", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([trackedIssue(42, "2020-01-01T00:00:00.000Z")]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    await getPruneFailureResolver().resolve();

    expect(fetch).toHaveBeenCalledTimes(3);
    const [listUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(listUrl)).toContain(
      `labels=${encodeURIComponent(PRUNE_FAILURE_LABEL)}`,
    );
    const [closeUrl, closeInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(closeUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues/42",
    );
    expect(closeInit?.method).toBe("PATCH");
    expect(JSON.parse(closeInit?.body as string)).toEqual({
      state: "closed",
      state_reason: "completed",
    });
    const [commentUrl, commentInit] = vi.mocked(fetch).mock.calls[2];
    expect(String(commentUrl)).toContain("/issues/42/comments");
    expect(JSON.parse(commentInit?.body as string)).toEqual({
      body: PRUNE_RECOVERED_COMMENT,
    });
  });
});
