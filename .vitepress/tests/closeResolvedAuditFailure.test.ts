import { describe, it, expect, vi } from "vitest";

import closeResolvedAuditFailure from "../../.github/scripts/close-resolved-audit-failure.cjs";
import notifyAuditFailure from "../../.github/scripts/notify-audit-failure.cjs";
import type { GithubIssueOrPullRequest } from "../../.github/scripts/notify-audit-failure.cjs";

// close-resolved-audit-failure.cjs is the module the
// "close-resolved-audit-failure" job's "Close resolved audit-failure issue"
// step (.github/workflows/security.yml) requires at runtime via
// actions/github-script. It's the recovery counterpart to
// notify-audit-failure.cjs (see notifyAuditFailure.test.ts): it reuses that
// script's `findOpenAuditFailureIssue` lookup so the close path always
// targets exactly the issue notify-audit-failure opened.

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
};

function buildGithubStub({
  existingIssues = [],
  listForRepoImpl,
  updateImpl,
}: GithubStubOptions = {}) {
  return {
    rest: {
      issues: {
        listForRepo: listForRepoImpl
          ? vi.fn().mockImplementation(listForRepoImpl)
          : vi.fn().mockResolvedValue({ data: existingIssues }),
        create: vi.fn().mockResolvedValue({ data: { number: 99 } }),
        createComment: vi.fn().mockResolvedValue({}),
        update: updateImpl
          ? vi.fn().mockImplementation(updateImpl)
          : vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function buildCoreStub() {
  return { info: vi.fn() };
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

    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const [commentArgs] = github.rest.issues.createComment.mock.calls[0];
    expect(commentArgs.issue_number).toBe(7);
    expect(commentArgs.body).toContain(
      "https://github.com/neonpixels-studio/neonpixels/actions/runs/42",
    );

    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    const [updateArgs] = github.rest.issues.update.mock.calls[0];
    expect(updateArgs.owner).toBe("neonpixels-studio");
    expect(updateArgs.repo).toBe("neonpixels");
    expect(updateArgs.issue_number).toBe(7);
    expect(updateArgs.state).toBe("closed");

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

  // The label alone isn't a reliable match — reuses notify-audit-failure's
  // guard, so a PR carrying the label or an unrelated issue without the body
  // marker must not be mistaken for the tracking issue and closed.
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

  it("propagates an error from closing the issue instead of swallowing it", async () => {
    const github = buildGithubStub({
      existingIssues: [trackedIssue(7)],
      updateImpl: () => Promise.reject(new Error("issues disabled")),
    });
    const core = buildCoreStub();

    await expect(
      closeResolvedAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("issues disabled");
  });
});
