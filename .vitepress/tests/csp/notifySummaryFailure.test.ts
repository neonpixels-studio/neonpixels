import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createSummaryFailureNotifier,
  getSummaryFailureNotifier,
  SUMMARY_FAILURE_LABEL,
  SUMMARY_FAILURE_ISSUE_TITLE,
  SUMMARY_FAILURE_ISSUE_MARKER,
  NOTIFY_THROTTLED_LOG_PREFIX,
  type GithubIssueOrPullRequest,
  type GithubIssuesClient,
} from "../../../netlify/functions/lib/notifySummaryFailure";
import { GITHUB_TOKEN_ENV_VAR } from "../../../netlify/functions/lib/githubFailureNotifier";

// The generic duplicate-guard/throttle mechanics and the fetch-based GitHub
// REST adapter this notifier is built on (createFailureNotifier,
// createFetchGithubIssuesClient) are exercised once, against a throwaway
// config, in githubFailureNotifier.test.ts — this file only covers what's
// specific to a summary failure: the label/title/marker/body
// createSummaryFailureNotifier configures, that it disables the re-notify
// throttle (renotifyIntervalMs: 0 — see notifySummaryFailure.ts for why),
// and that getSummaryFailureNotifier() wires them through to the real
// adapter. See #137.

function trackedIssue(
  number: number,
  updatedAt: string,
): GithubIssueOrPullRequest {
  return {
    number,
    body: `${SUMMARY_FAILURE_ISSUE_MARKER}\nOriginal failure body.`,
    pull_request: undefined,
    updated_at: updatedAt,
  };
}

function buildGithubClientStub(
  existingIssues: GithubIssueOrPullRequest[] = [],
): GithubIssuesClient {
  return {
    listOpenIssuesByLabel: vi.fn().mockResolvedValue(existingIssues),
    createIssue: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createSummaryFailureNotifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an issue labeled/titled/marked for a summary failure, with the error in the body", async () => {
    const client = buildGithubClientStub();
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(
      SUMMARY_FAILURE_LABEL,
    );
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const [createArgs] = vi.mocked(client.createIssue).mock.calls[0];
    expect(createArgs.title).toBe(SUMMARY_FAILURE_ISSUE_TITLE);
    expect(createArgs.labels).toEqual([SUMMARY_FAILURE_LABEL]);
    expect(createArgs.body).toContain(SUMMARY_FAILURE_ISSUE_MARKER);
    expect(createArgs.body).toContain("daily csp-report-summary");
    expect(createArgs.body).toContain("blobs unavailable");
  });

  // Unlike the prune notifier (hourly, so RENOTIFY_INTERVAL_MS actually
  // suppresses same-streak comments), the summary notifier's own @daily
  // cadence is already sparser than any meaningful throttle window —
  // consecutive runs are 24h apart regardless. It passes
  // renotifyIntervalMs: 0 so every failed run comments/creates rather than
  // risking a human's unrelated issue touch (bumping updated_at) silencing
  // a whole day's failure for no throttling benefit. The throttle mechanics
  // themselves (including the renotifyIntervalMs: 0 branch) are covered
  // generically in githubFailureNotifier.test.ts; this only pins that
  // createSummaryFailureNotifier is wired to disable it.
  it("comments even when a tracked issue was updated a second ago, since the daily cadence disables the throttle", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = buildGithubClientStub([
      trackedIssue(7, new Date(Date.now() - 1000).toISOString()),
    ]);
    const notifier = createSummaryFailureNotifier(client);

    await notifier.notify("blobs unavailable");

    expect(client.createComment).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      NOTIFY_THROTTLED_LOG_PREFIX,
      expect.anything(),
    );
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

  // The real fetch adapter itself (auth, endpoints, error handling) is
  // covered generically in githubFailureNotifier.test.ts; this only proves
  // getSummaryFailureNotifier() wires the summary label/title/marker
  // through to it correctly.
  it("wires the real fetch adapter to the summary label/title/marker when opening a new issue", async () => {
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
    const [listUrl] = vi.mocked(fetch).mock.calls[0];
    expect(String(listUrl)).toContain(
      `labels=${encodeURIComponent(SUMMARY_FAILURE_LABEL)}`,
    );
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(createUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues",
    );
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody).toEqual({
      title: SUMMARY_FAILURE_ISSUE_TITLE,
      labels: [SUMMARY_FAILURE_LABEL],
      body: expect.stringContaining(SUMMARY_FAILURE_ISSUE_MARKER),
    });
  });
});
