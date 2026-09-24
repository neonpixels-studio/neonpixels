import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createPruneFailureNotifier,
  getPruneFailureNotifier,
  PRUNE_FAILURE_LABEL,
  PRUNE_FAILURE_ISSUE_TITLE,
  PRUNE_FAILURE_ISSUE_MARKER,
  NOTIFY_THROTTLED_LOG_PREFIX,
} from "../../../netlify/functions/lib/notifyPruneFailure";
import { GITHUB_TOKEN_ENV_VAR } from "../../../netlify/functions/lib/githubFailureNotifier";
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
