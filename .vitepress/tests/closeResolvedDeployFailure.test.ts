import { describe, it, expect, vi } from "vitest";

import closeResolvedDeployFailure from "../../.github/scripts/close-resolved-deploy-failure.cjs";
import notifyDeployFailure from "../../.github/scripts/notify-deploy-failure.cjs";

const { ISSUE_MARKER, DEPLOY_FAILURE_LABEL } = notifyDeployFailure;

const REPO_CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 42,
};

type StubIssue = { number: number; body: string; pull_request?: object };

function trackedIssue(number: number): StubIssue {
  return { number, body: `${ISSUE_MARKER}\nOriginal failure body.` };
}

function buildStubs({
  issues = [],
  updateImpl,
  createCommentImpl,
}: {
  issues?: StubIssue[];
  updateImpl?: (_params: { issue_number: number }) => Promise<unknown>;
  createCommentImpl?: () => Promise<unknown>;
} = {}) {
  const github = {
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: issues }),
        update: vi.fn().mockImplementation(updateImpl ?? (async () => ({}))),
        createComment: vi
          .fn()
          .mockImplementation(createCommentImpl ?? (async () => ({}))),
        create: vi.fn(),
      },
    },
  };
  const core = { info: vi.fn(), warning: vi.fn() };
  return { github, core };
}

describe("closeResolvedDeployFailure", () => {
  it("closes and comments on the open tracked deploy-failure issue", async () => {
    const { github, core } = buildStubs({ issues: [trackedIssue(7)] });

    await closeResolvedDeployFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ state: "open", labels: DEPLOY_FAILURE_LABEL }),
    );
    expect(github.rest.issues.update).toHaveBeenCalledWith({
      owner: "neonpixels-studio",
      repo: "neonpixels",
      issue_number: 7,
      state: "closed",
    });
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        body: expect.stringContaining(
          "https://github.com/neonpixels-studio/neonpixels/actions/runs/42",
        ),
      }),
    );
  });

  it("does nothing when no tracked issue is open", async () => {
    const { github, core } = buildStubs();

    await closeResolvedDeployFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("ignores pull requests and issues without the marker", async () => {
    const { github, core } = buildStubs({
      issues: [
        { number: 1, body: "unrelated" },
        { ...trackedIssue(2), pull_request: {} },
      ],
    });

    await closeResolvedDeployFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).not.toHaveBeenCalled();
  });

  it("warns, but does not fail, when only the comment fails", async () => {
    const { github, core } = buildStubs({
      issues: [trackedIssue(7)],
      createCommentImpl: async () => {
        throw new Error("comment down");
      },
    });

    await closeResolvedDeployFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("comment down"),
    );
  });

  it("closes the remaining issues, then throws, when one close fails", async () => {
    const { github, core } = buildStubs({
      issues: [trackedIssue(7), trackedIssue(8)],
      updateImpl: async ({ issue_number }) => {
        if (issue_number === 7) {
          throw new Error("api down");
        }
        return {};
      },
    });

    await expect(
      closeResolvedDeployFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("#7: api down");
    expect(github.rest.issues.update).toHaveBeenCalledTimes(2);
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 8 }),
    );
  });
});
