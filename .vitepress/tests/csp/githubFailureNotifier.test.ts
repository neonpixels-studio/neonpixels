import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import {
  createFailureNotifier,
  createFetchGithubIssuesClient,
  sanitizeReportedError,
  buildStillFailingCommentBody,
  GITHUB_TOKEN_ENV_VAR,
  RENOTIFY_INTERVAL_MS,
  type FailureNotifierConfig,
  type GithubComment,
} from "../../../netlify/functions/lib/githubFailureNotifier";
import {
  buildGithubClientStub,
  trackedIssue as trackedIssueWithMarker,
} from "../helpers/githubIssuesClientStub";

// Exercises the generic duplicate-guard/throttle mechanics
// (createFailureNotifier) and the fetch-based GitHub REST adapter
// (createFetchGithubIssuesClient) once, against a throwaway config — every
// concrete notifier built on this module (notifyPruneFailure.ts,
// notifySummaryFailure.ts) reuses this exact behavior, so their own test
// files only cover what's specific to them: the label/title/marker/body
// they configure, and that their public factory wires it through correctly
// (see #123, #137).

const TEST_LABEL = "test-failure-label";
const TEST_ISSUE_TITLE = "Scheduled test Function failed";
const TEST_ISSUE_MARKER = "<!-- test:failure-notifier -->";
const TEST_THROTTLED_LOG_PREFIX = "test-notify-throttled";

function buildTestIssueBody(errorMessage: string): string {
  return `${TEST_ISSUE_MARKER}\n${errorMessage}`;
}

function testConfig(
  overrides: Partial<FailureNotifierConfig> = {},
): FailureNotifierConfig {
  return {
    trackingLabel: TEST_LABEL,
    issueTitle: TEST_ISSUE_TITLE,
    issueMarker: TEST_ISSUE_MARKER,
    buildIssueBody: buildTestIssueBody,
    throttledLogPrefix: TEST_THROTTLED_LOG_PREFIX,
    renotifyIntervalMs: RENOTIFY_INTERVAL_MS,
    ...overrides,
  };
}

function trackedIssue(number: number, createdAt?: string) {
  return trackedIssueWithMarker(TEST_ISSUE_MARKER, number, createdAt);
}

// A comment authored by this notifier itself — carries the same marker as a
// tracked issue's body. Built from the real production body-builder rather
// than a hand-written literal, so this stays in lockstep with what the
// notifier actually posts — a hand-written marker here would keep passing
// even if buildStillFailingCommentBody stopped stamping the marker in
// production.
function notifierComment(createdAt: string): GithubComment {
  return {
    body: buildStillFailingCommentBody(TEST_ISSUE_MARKER, "boom"),
    created_at: createdAt,
  };
}

// A comment from someone/something other than this notifier (a human reply,
// a label-change side effect, another bot) — no marker in the body.
function humanComment(createdAt: string): GithubComment {
  return {
    body: "Looking into this.",
    created_at: createdAt,
  };
}

describe("createFailureNotifier", () => {
  it("creates an issue when no open tracked issue exists", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const [createArgs] = client.createIssue.mock.calls[0];
    expect(createArgs.title).toBe(TEST_ISSUE_TITLE);
    expect(createArgs.labels).toEqual([TEST_LABEL]);
    expect(createArgs.body).toContain(TEST_ISSUE_MARKER);
    expect(createArgs.body).toContain("blobs unavailable");
  });

  it("looks up existing issues by the configured tracking label", async () => {
    const client = buildGithubClientStub({ existingIssues: [] });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("blobs unavailable");

    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith(TEST_LABEL);
  });

  it("comments on an existing open tracked issue instead of opening a duplicate", async () => {
    const client = buildGithubClientStub({ existingIssues: [trackedIssue(7)] });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("timeout exceeded");

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
    const [issueNumber, body] = client.createComment.mock.calls[0];
    expect(issueNumber).toBe(7);
    expect(body).toContain("timeout exceeded");
  });

  // The issues list endpoint returns pull requests alongside issues. A PR
  // that happens to carry the tracking label (e.g. tagged for unrelated
  // triage) must not be mistaken for an existing notification and
  // permanently suppress real ones.
  it("ignores pull requests carrying the tracking label", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: TEST_ISSUE_MARKER, pull_request: {} },
      ],
    });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  // The label alone isn't a reliable match — an unrelated issue could carry
  // it during manual triage. Only an issue whose body carries the
  // configured marker should suppress a new notification.
  it("ignores an open issue with the label but no marker in its body", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 5, body: "Unrelated issue.", pull_request: undefined },
      ],
    });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("blobs unavailable");

    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("does not throw when an issue has no body at all", async () => {
    const client = buildGithubClientStub({
      existingIssues: [{ number: 6, pull_request: undefined }],
    });
    const notifier = createFailureNotifier(client, testConfig());

    await expect(notifier.notify("blobs unavailable")).resolves.toBeUndefined();
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("creates an issue when only a pull request matches but no real issue does", async () => {
    const client = buildGithubClientStub({
      existingIssues: [
        { number: 3, body: TEST_ISSUE_MARKER, pull_request: {} },
        trackedIssue(8),
      ],
    });
    const notifier = createFailureNotifier(client, testConfig());

    await notifier.notify("blobs unavailable");

    // The real issue (#8) is the match; the PR (#3) must not mask it.
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledTimes(1);
  });

  // Fail-loud: a broken notifier (bad token, disabled issues, transient API
  // error) should surface to the caller instead of being swallowed here —
  // the calling Netlify Function's own catch block is what decides how to
  // log a failure of the notifier itself.
  it("propagates an error from the duplicate check instead of swallowing it", async () => {
    const client = buildGithubClientStub({
      listOpenIssuesByLabelImpl: () =>
        Promise.reject(new Error("API unavailable")),
    });
    const notifier = createFailureNotifier(client, testConfig());

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
    const notifier = createFailureNotifier(client, testConfig());

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issues disabled",
    );
  });

  // Symmetric with the issue-creation case above: a locked/archived tracked
  // issue rejecting the comment call must reject out of notify() too, so
  // the caller logs its own notify-failed marker rather than treating a
  // failed comment as a delivered notification.
  it("propagates an error from commenting instead of swallowing it", async () => {
    const client = buildGithubClientStub({ existingIssues: [trackedIssue(7)] });
    client.createComment.mockRejectedValueOnce(new Error("issue locked"));
    const notifier = createFailureNotifier(client, testConfig());

    await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
      "issue locked",
    );
  });

  describe("re-notify throttle", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Without a throttle, a failure streak denser than the window would
    // pile up one near-identical "still failing" comment per run and bury
    // the original diagnosis. Pinned against RENOTIFY_INTERVAL_MS itself
    // (rather than "now" vs. a fixed 2020 date) so the assertion actually
    // fails if the interval changes — a fixed pair of timestamps would
    // still pass for any interval from roughly a second to several years.
    const JUST_INSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS - 60_000;
    const JUST_OUTSIDE_WINDOW_MS = RENOTIFY_INTERVAL_MS + 60_000;

    // No notifier comment exists yet, so the fallback (the tracked issue's
    // own created_at — see resolveLastNotifiedAt) drives the throttle. This
    // is the state right after the notifier's first "opened the issue"
    // notification.
    it("does not re-comment on a freshly-opened tracked issue created just inside the re-notify window, and logs the throttle", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      const trackedIssueCreatedAt = new Date(
        Date.now() - JUST_INSIDE_WINDOW_MS,
      ).toISOString();
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, trackedIssueCreatedAt)],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).not.toHaveBeenCalled();
      expect(client.createIssue).not.toHaveBeenCalled();
      // Without this, the throttled path is silent: the caller only logs
      // on the underlying failure, so a deliberate no-op and a
      // silently-broken notifier would otherwise be indistinguishable in
      // the logs. Asserts the full payload (not just that the "issue"
      // field is present) so a dropped, misnamed, or malformed
      // lastNotifiedAt field would fail this test.
      expect(consoleLogSpy).toHaveBeenCalledWith(
        TEST_THROTTLED_LOG_PREFIX,
        JSON.stringify({
          issue: 7,
          lastNotifiedAt: trackedIssueCreatedAt,
        }),
      );
    });

    it("comments again once a freshly-opened tracked issue's creation is just outside the re-notify window", async () => {
      const client = buildGithubClientStub({
        existingIssues: [
          trackedIssue(
            7,
            new Date(Date.now() - JUST_OUTSIDE_WINDOW_MS).toISOString(),
          ),
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    it("comments when the tracked issue has no created_at and no notifier comments at all", async () => {
      const client = buildGithubClientStub({
        existingIssues: [
          { number: 7, body: TEST_ISSUE_MARKER, pull_request: undefined },
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    // This is the #139 fix itself: the tracked issue's own created_at is
    // ancient (well outside the window), but this notifier's own last
    // comment is recent — the throttle must key off the comment, not fall
    // through to the stale issue-creation fallback.
    it("does not re-comment when this notifier's own last comment is inside the re-notify window, even though the issue itself is old", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [
          notifierComment(
            new Date(Date.now() - JUST_INSIDE_WINDOW_MS).toISOString(),
          ),
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).not.toHaveBeenCalled();
    });

    // The core regression this fixes: a human comment (or any other
    // activity that used to bump the issue's `updated_at`, e.g. a label
    // change) must NOT reset the throttle — only this notifier's own
    // comment does. Both comments are inside the window; only one is this
    // notifier's.
    it("does not treat a human's own recent comment as a re-notification — only this notifier's own comment resets the throttle", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [
          // This notifier's last comment is just outside the window...
          notifierComment(
            new Date(Date.now() - JUST_OUTSIDE_WINDOW_MS).toISOString(),
          ),
          // ...but a human replied well inside the window afterward. Under
          // the old updated_at-based throttle this would have silenced the
          // notifier; it must not here.
          humanComment(new Date(Date.now() - 60_000).toISOString()),
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("still broken");

      // Throttled off the human comment, this would be a no-op; the fix
      // means it re-comments because the notifier's own last comment is
      // stale.
      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    // Guards isNotifierComment's use of startsWith over includes: GitHub's
    // "Quote reply" copies a quoted comment's raw body — marker included —
    // with each line prefixed by `> `. That must NOT be mistaken for a
    // fresh notification, or a maintainer quoting the notifier's own "still
    // failing" comment to reply "on it" would reintroduce the exact bug
    // this throttle rework fixes (unrelated human activity silencing the
    // notifier).
    it("does not treat a human's quote-reply of the notifier's own comment as a re-notification", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [
          notifierComment(
            new Date(Date.now() - JUST_OUTSIDE_WINDOW_MS).toISOString(),
          ),
          {
            body: `> ${buildStillFailingCommentBody(TEST_ISSUE_MARKER, "boom").replaceAll("\n", "\n> ")}\n\nOn it.`,
            created_at: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("still broken");

      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    it("throttles based on the most recent of this notifier's own comments when it has posted more than one", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [
          notifierComment(
            new Date(Date.now() - JUST_OUTSIDE_WINDOW_MS).toISOString(),
          ),
          notifierComment(
            new Date(Date.now() - JUST_INSIDE_WINDOW_MS).toISOString(),
          ),
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).not.toHaveBeenCalled();
    });

    // Guards resolveLastNotifiedAt's Math.max over parsed timestamps: an
    // unparseable created_at on one notifier comment must not poison the
    // comparison and hide a separate, genuinely recent, valid notifier
    // comment behind it.
    it("ignores a notifier comment with an unparseable created_at and still throttles off a valid recent one", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [
          notifierComment("not-a-real-date"),
          notifierComment(
            new Date(Date.now() - JUST_INSIDE_WINDOW_MS).toISOString(),
          ),
        ],
      });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.createComment).not.toHaveBeenCalled();
    });

    // A notifier whose own schedule is already sparser than any meaningful
    // window (e.g. notifySummaryFailure.ts's daily cadence) passes
    // renotifyIntervalMs: 0 so every failed run comments/creates regardless
    // of the tracked issue's own comment history.
    it("never throttles when renotifyIntervalMs is 0, even for a notifier comment posted a second ago", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
        comments: [notifierComment(new Date(Date.now() - 1000).toISOString())],
      });
      const notifier = createFailureNotifier(
        client,
        testConfig({ renotifyIntervalMs: 0 }),
      );

      await notifier.notify("blobs unavailable");

      expect(client.createComment).toHaveBeenCalledTimes(1);
    });

    // Asserts against the fake client rather than only through the real
    // fetch adapter's URL string: the throttle window (renotifyIntervalMs)
    // is domain policy computed in notify() itself and handed to
    // listComments as a plain argument, specifically so a fake client can
    // observe and honor the same window a real GitHub call would.
    it("passes the tracked issue's number and a since timestamp scoped to the re-notify window to listComments", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7, "2020-01-01T00:00:00.000Z")],
      });
      const notifier = createFailureNotifier(client, testConfig());
      const beforeCall = Date.now();

      await notifier.notify("blobs unavailable");

      expect(client.listComments).toHaveBeenCalledTimes(1);
      const [issueNumber, sinceIso] = client.listComments.mock.calls[0];
      expect(issueNumber).toBe(7);
      const sinceMs = Date.parse(sinceIso);
      const expectedSinceMs = beforeCall - RENOTIFY_INTERVAL_MS;
      // Allow a small window for test execution time rather than asserting
      // exact equality against a value computed before the call ran.
      expect(Math.abs(sinceMs - expectedSinceMs)).toBeLessThan(5000);
    });

    it("does not call listComments when opening a brand-new issue", async () => {
      const client = buildGithubClientStub({ existingIssues: [] });
      const notifier = createFailureNotifier(client, testConfig());

      await notifier.notify("blobs unavailable");

      expect(client.listComments).not.toHaveBeenCalled();
    });

    // A notifier with the throttle disabled (renotifyIntervalMs: 0) skips
    // the listComments lookup entirely rather than paying for a call whose
    // result can never matter.
    it("does not call listComments when renotifyIntervalMs is 0", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7)],
      });
      const notifier = createFailureNotifier(
        client,
        testConfig({ renotifyIntervalMs: 0 }),
      );

      await notifier.notify("blobs unavailable");

      expect(client.listComments).not.toHaveBeenCalled();
    });

    // Symmetric with the issue-creation/comment propagation tests above: a
    // broken listComments call (bad token, disabled issues) must surface
    // instead of silently falling back to "never notified" and commenting
    // anyway.
    it("propagates an error from listComments instead of swallowing it", async () => {
      const client = buildGithubClientStub({
        existingIssues: [trackedIssue(7)],
        listCommentsImpl: () => Promise.reject(new Error("API unavailable")),
      });
      const notifier = createFailureNotifier(client, testConfig());

      await expect(notifier.notify("blobs unavailable")).rejects.toThrow(
        "API unavailable",
      );
      expect(client.createComment).not.toHaveBeenCalled();
    });
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
  // relying on the URL pattern above to also catch it. Uses a
  // credential-shaped value with no recognized vendor prefix (gh*_/nfp_) so
  // this actually exercises the bearer/token alternative of SECRET_PATTERN
  // rather than passing for the wrong reason via the vendor-prefix
  // alternative below.
  it("redacts a bearer-style credential with no URL present", () => {
    expect(
      sanitizeReportedError(
        "Netlify Blobs: request rejected, sent header authorization: Bearer AbCdEf0123456789 failed",
      ),
    ).not.toContain("AbCdEf0123456789");
  });

  it("redacts a GitHub-style prefixed token", () => {
    expect(sanitizeReportedError("auth failed for ghp_abcdefghijklmnop")).toBe(
      "auth failed for [secret redacted]",
    );
  });

  // The secret pattern requires a credential-shaped (12+ char) run after
  // "token"/"bearer" specifically so ordinary English isn't mistaken for a
  // credential and redacted into an uninformative issue body — this is the
  // single most likely real failure message (an expired/invalid PAT).
  it("does not redact ordinary English containing the word token or bearer", () => {
    expect(sanitizeReportedError("token expired")).toBe("token expired");
    expect(sanitizeReportedError("auth token is invalid")).toBe(
      "auth token is invalid",
    );
  });
});

describe("createFetchGithubIssuesClient", () => {
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
    const client = createFetchGithubIssuesClient();

    await expect(client.listOpenIssuesByLabel(TEST_LABEL)).rejects.toThrow(
      `${GITHUB_TOKEN_ENV_VAR} is not set`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates a list request with the configured token and hits the right endpoint", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ number: 7, body: TEST_ISSUE_MARKER }]), {
        status: 200,
      }),
    );
    const client = createFetchGithubIssuesClient();

    const issues = await client.listOpenIssuesByLabel(TEST_LABEL);

    expect(issues).toEqual([{ number: 7, body: TEST_ISSUE_MARKER }]);
    const [listUrl, listInit] = vi.mocked(fetch).mock.calls[0];
    const listUrlString = String(listUrl);
    // The duplicate-guard mechanism lives entirely in this query string —
    // asserting only that the URL contains the base path would still pass
    // if state/labels/per_page were dropped.
    expect(listUrlString).toContain(
      "/repos/neonpixels-studio/neonpixels/issues",
    );
    expect(listUrlString).toContain("state=open");
    expect(listUrlString).toContain(`labels=${encodeURIComponent(TEST_LABEL)}`);
    expect(listUrlString).toContain("per_page=100");
    expect((listInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("authenticates a comment request with the configured token and hits the right endpoint", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 201 }));
    const client = createFetchGithubIssuesClient();

    await client.createComment(7, "still failing");

    const [commentUrl, commentInit] = vi.mocked(fetch).mock.calls[0];
    expect(String(commentUrl)).toContain(
      "/repos/neonpixels-studio/neonpixels/issues/7/comments",
    );
    expect((commentInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(JSON.parse(commentInit?.body as string)).toEqual({
      body: "still failing",
    });
  });

  it("opens a new issue with the requested title/labels/body", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ number: 42, labels: [{ name: TEST_LABEL }] }),
        { status: 201 },
      ),
    );
    const client = createFetchGithubIssuesClient();

    await client.createIssue({
      title: TEST_ISSUE_TITLE,
      labels: [TEST_LABEL],
      body: "body text",
    });

    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[0];
    expect(String(createUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues",
    );
    expect(createInit?.method).toBe("POST");
    expect(JSON.parse(createInit?.body as string)).toEqual({
      title: TEST_ISSUE_TITLE,
      labels: [TEST_LABEL],
      body: "body text",
    });
  });

  // GitHub silently drops labels the token can't apply instead of erroring.
  // If that happened here, the duplicate guard (which filters
  // listOpenIssuesByLabel by this exact label) would never see the issue
  // again, and every subsequent failure would open a fresh duplicate rather
  // than finding this one. The issue already exists once this is detected,
  // so a bare throw would itself orphan an unlabeled issue every run —
  // retrying the label attach directly is what actually prevents the flood.
  it("retries attaching labels when GitHub creates the issue without them", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42, labels: [] }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = createFetchGithubIssuesClient();

    await expect(
      client.createIssue({
        title: TEST_ISSUE_TITLE,
        labels: [TEST_LABEL],
        body: "body text",
      }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    const [labelUrl, labelInit] = vi.mocked(fetch).mock.calls[1];
    expect(String(labelUrl)).toBe(
      "https://api.github.com/repos/neonpixels-studio/neonpixels/issues/42/labels",
    );
    expect(labelInit?.method).toBe("POST");
    expect(JSON.parse(labelInit?.body as string)).toEqual({
      labels: [TEST_LABEL],
    });
  });

  it("throws, naming the orphaned issue, when the label-attach retry also fails", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 42, labels: [] }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const client = createFetchGithubIssuesClient();

    await expect(
      client.createIssue({
        title: TEST_ISSUE_TITLE,
        labels: [TEST_LABEL],
        body: "body text",
      }),
    ).rejects.toThrow(
      /did not apply all requested labels .* to issue #42.*label attach also failed/,
    );
  });

  it("throws a descriptive error when the GitHub API responds with a non-OK status", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad credentials", { status: 401 }),
    );
    const client = createFetchGithubIssuesClient();

    await expect(client.listOpenIssuesByLabel(TEST_LABEL)).rejects.toThrow(
      /GitHub API GET .* failed: 401/,
    );
  });

  it("truncates a large non-OK error body instead of dumping it whole into the thrown message", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("x".repeat(10000), { status: 502 }),
    );
    const client = createFetchGithubIssuesClient();

    const error = await client
      .listOpenIssuesByLabel(TEST_LABEL)
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
    const client = createFetchGithubIssuesClient();

    await expect(client.listOpenIssuesByLabel(TEST_LABEL)).rejects.toThrow(
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
    const client = createFetchGithubIssuesClient();

    await expect(client.listOpenIssuesByLabel(TEST_LABEL)).rejects.toThrow(
      "GitHub API issues list response was not an array",
    );
  });

  it("authenticates a listComments request with the configured token, since param, and hits the right endpoint", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ body: "still failing" }]), {
        status: 200,
      }),
    );
    const client = createFetchGithubIssuesClient();
    const sinceIso = new Date(Date.now() - RENOTIFY_INTERVAL_MS).toISOString();

    const comments = await client.listComments(7, sinceIso);

    expect(comments).toEqual([{ body: "still failing" }]);
    const [listUrl, listInit] = vi.mocked(fetch).mock.calls[0];
    const listUrlString = String(listUrl);
    expect(listUrlString).toContain(
      "/repos/neonpixels-studio/neonpixels/issues/7/comments",
    );
    expect(listUrlString).toContain("per_page=100");
    // Confirms the pagination fix: listComments must scope the request to
    // the throttle window via `since` rather than trusting an unfiltered
    // page 1, which on a busy issue could permanently hide a genuinely
    // recent comment behind older ones (GitHub returns issue comments
    // oldest-first).
    expect(listUrlString).toContain(`since=${encodeURIComponent(sinceIso)}`);
    expect((listInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("throws a descriptive error when the comments list response is valid JSON but not an array", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 200,
      }),
    );
    const client = createFetchGithubIssuesClient();

    await expect(
      client.listComments(7, "2020-01-01T00:00:00.000Z"),
    ).rejects.toThrow("GitHub API comments list response was not an array");
  });

  it("throws a descriptive error when the comments list response isn't valid JSON", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = "test-token";
    vi.mocked(fetch).mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );
    const client = createFetchGithubIssuesClient();

    await expect(
      client.listComments(7, "2020-01-01T00:00:00.000Z"),
    ).rejects.toThrow("GitHub API comments list response was not valid JSON");
  });
});
