import { describe, it, expect, vi } from "vitest";

import closeResolvedAuditFailure from "../../.github/scripts/close-resolved-audit-failure.cjs";
import notifyAuditFailure from "../../.github/scripts/notify-audit-failure.cjs";
import type { GithubIssueOrPullRequest } from "../../.github/scripts/notify-audit-failure.cjs";

// close-resolved-audit-failure.cjs is the module the
// "close-resolved-audit-failure" job's "Close resolved audit-failure issue"
// step (.github/workflows/security.yml) requires at runtime via
// actions/github-script. It's the recovery counterpart to
// notify-audit-failure.cjs (see notifyAuditFailure.test.ts): it reuses that
// script's `findOpenAuditFailureIssues` lookup so the close path always
// targets exactly the issue(s) notify-audit-failure opened.

const { ISSUE_MARKER } = notifyAuditFailure;

const REPO_CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 42,
};

type GithubStubOptions = {
  existingIssues?: GithubIssueOrPullRequest[];
  listForRepoImpl?: () => Promise<{ data: GithubIssueOrPullRequest[] }>;
  updateImpl?: () => Promise<unknown>;
  createCommentImpl?: () => Promise<unknown>;
};

function buildGithubStub({
  existingIssues = [],
  listForRepoImpl,
  updateImpl,
  createCommentImpl,
}: GithubStubOptions = {}) {
  return {
    rest: {
      issues: {
        listForRepo: listForRepoImpl
          ? vi.fn().mockImplementation(listForRepoImpl)
          : vi.fn().mockResolvedValue({ data: existingIssues }),
        createComment: createCommentImpl
          ? vi.fn().mockImplementation(createCommentImpl)
          : vi.fn().mockResolvedValue({}),
        update: updateImpl
          ? vi.fn().mockImplementation(updateImpl)
          : vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function buildCoreStub() {
  return { info: vi.fn(), warning: vi.fn() };
}

// A tracked issue is one notify-audit-failure.cjs itself opened: carries the
// marker in its body (the label alone isn't a reliable match — see
// notifyAuditFailure.test.ts's "unrelated issue" tests).
function trackedIssue(number: number) {
  return {
    number,
    body: `${ISSUE_MARKER}\nOriginal failure body.`,
    pull_request: undefined,
  };
}

describe("closeResolvedAuditFailure", () => {
  it("closes and comments on the open tracked audit-failure issue", async () => {
    const github = buildGithubStub({ existingIssues: [trackedIssue(7)] });
    const core = buildCoreStub();

    await closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    const [updateArgs] = github.rest.issues.update.mock.calls[0];
    expect(updateArgs.owner).toBe("neonpixels-studio");
    expect(updateArgs.repo).toBe("neonpixels");
    expect(updateArgs.issue_number).toBe(7);
    expect(updateArgs.state).toBe("closed");

    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const [commentArgs] = github.rest.issues.createComment.mock.calls[0];
    expect(commentArgs.issue_number).toBe(7);
    expect(commentArgs.body).toContain(
      "https://github.com/neonpixels-studio/neonpixels/actions/runs/42",
    );

    // Closing is the state change that actually stops the issue from piling
    // up; it must land before the purely cosmetic comment, not after.
    const updateOrder = github.rest.issues.update.mock.invocationCallOrder[0];
    const commentOrder =
      github.rest.issues.createComment.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(commentOrder);

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("#7"));
  });

  it("does nothing when no open audit-failure issue exists", async () => {
    const github = buildGithubStub({ existingIssues: [] });
    const core = buildCoreStub();

    await closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(github.rest.issues.update).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("No open audit-failure issue"),
    );
  });

  // Normally at most one tracked issue is open, but a human reopening one,
  // or two scheduled runs racing, could leave more than one open. The close
  // path must clear all of them, not just whichever the API lists first.
  it("closes every open tracked issue, not just the first", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7), trackedIssue(9)],
    });
    const core = buildCoreStub();

    await closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).toHaveBeenCalledTimes(2);
    const closedIssueNumbers = github.rest.issues.update.mock.calls.map(
      ([params]) => params.issue_number,
    );
    expect(closedIssueNumbers).toEqual([7, 9]);
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(2);
  });

  // The label alone isn't a reliable match — reuses notify-audit-failure's
  // guard, so a PR carrying the label or an unrelated issue without the body
  // marker must not be mistaken for the tracking issue: closed OR commented
  // on. A comment on the wrong issue/PR is exactly the misfire the marker
  // guard exists to prevent, so both must be asserted, not just the close.
  it("ignores pull requests and unrelated issues carrying the label", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 3, body: ISSUE_MARKER, pull_request: { url: "..." } },
        { number: 5, body: "Unrelated issue.", pull_request: undefined },
      ],
    });
    const core = buildCoreStub();

    await closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("closes the real tracked issue even when a labeled pull request also matches the label filter", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 3, body: ISSUE_MARKER, pull_request: { url: "..." } },
        trackedIssue(8),
      ],
    });
    const core = buildCoreStub();

    await closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.update.mock.calls[0][0].issue_number).toBe(8);
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.createComment.mock.calls[0][0].issue_number).toBe(
      8,
    );
  });

  // Fail-loud: a broken closer (bad token, disabled issues, transient API
  // error) should surface as a visible workflow failure, not be swallowed —
  // silence would let stale audit-failure issues pile up unnoticed.
  it("propagates an error from the duplicate check instead of swallowing it", async () => {
    const github = buildGithubStub({
      listForRepoImpl: () => Promise.reject(new Error("API unavailable")),
    });
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("API unavailable");
    expect(github.rest.issues.update).not.toHaveBeenCalled();
  });

  it("propagates an error from closing the issue instead of swallowing it, without commenting first", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7)],
      updateImpl: () => Promise.reject(new Error("issues disabled")),
    });
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("issues disabled");
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  // A failed recovery comment is NOT a failed close: the issue already
  // closed successfully, so reporting this as "failed to close" would send
  // a maintainer to investigate an issue that isn't actually stuck open.
  // core.warning still surfaces it as a visible workflow annotation, so it
  // isn't silently swallowed either.
  it("warns (without throwing) when the recovery comment fails on an already-closed issue", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7)],
      createCommentImpl: () => Promise.reject(new Error("issue locked")),
    });
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).resolves.toBeUndefined();

    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("issue locked"),
    );
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("#7"));
  });

  // One issue's comment failing must not mask the rest: if it did, a single
  // locked issue would permanently prevent every other tracked issue's
  // recovery comment from ever posting. (The close itself has its own,
  // separate resilience test below, since a close failure — unlike a
  // comment failure — is fatal and collected across the loop.)
  it("still comments on remaining issues when one issue's comment fails", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7), trackedIssue(9)],
    });
    github.rest.issues.createComment = vi
      .fn()
      .mockRejectedValueOnce(new Error("issue #7 locked"))
      .mockResolvedValueOnce({});
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).resolves.toBeUndefined();

    // Both issues were closed, and #9's comment still posted despite #7's
    // comment failing.
    expect(github.rest.issues.update).toHaveBeenCalledTimes(2);
    const closedIssueNumbers = github.rest.issues.update.mock.calls.map(
      ([params]) => params.issue_number,
    );
    expect(closedIssueNumbers).toEqual([7, 9]);
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("#7"));
  });

  // One issue failing to *close* (a transient API error, unlike a comment
  // failure) must not abort the rest — otherwise a single stuck issue would
  // permanently mask every other issue this loop exists to clear.
  it("still closes remaining issues when one issue's close fails", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7), trackedIssue(9)],
    });
    github.rest.issues.update = vi
      .fn()
      .mockRejectedValueOnce(new Error("issue #7 locked"))
      .mockResolvedValueOnce({});
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("#7: issue #7 locked");

    expect(github.rest.issues.update).toHaveBeenCalledTimes(2);
    const closedIssueNumbers = github.rest.issues.update.mock.calls.map(
      ([params]) => params.issue_number,
    );
    expect(closedIssueNumbers).toEqual([7, 9]);
    // #7 never closed, so it was never commented on either; #9 still was.
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.createComment.mock.calls[0][0].issue_number).toBe(
      9,
    );
  });
});
