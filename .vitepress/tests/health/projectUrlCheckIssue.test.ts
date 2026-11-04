import { describe, it, expect, vi } from "vitest";

import {
  ISSUE_MARKER,
  ISSUE_TITLE,
  PROJECT_URL_FAILURE_LABEL,
  closeResolvedProjectUrlFailure,
  notifyProjectUrlFailure,
} from "../../../.github/scripts/project-url-check-issue.cjs";
import type { TrackedIssueOrPullRequest } from "../../../.github/scripts/project-url-check-issue.cjs";

const CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 7,
};
const RUN_URL =
  "https://github.com/neonpixels-studio/neonpixels/actions/runs/7";

function buildStubs(
  existingIssues: TrackedIssueOrPullRequest[] = [],
  updateImpl?: (_params: { issue_number: number }) => Promise<unknown>,
) {
  const issues = {
    listForRepo: vi.fn().mockResolvedValue({ data: existingIssues }),
    create: vi.fn().mockResolvedValue({ data: { number: 99 } }),
    update: vi.fn().mockImplementation(updateImpl ?? (async () => ({}))),
    createComment: vi.fn().mockResolvedValue({}),
  };
  const core = { info: vi.fn(), warning: vi.fn() };
  return { issues, core, github: { rest: { issues } } };
}

const tracked = (number: number) => ({
  number,
  body: `${ISSUE_MARKER}\nbody`,
});

describe("notifyProjectUrlFailure", () => {
  it("opens one labeled issue with the marker when none is open", async () => {
    const { github, core, issues } = buildStubs();
    await notifyProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.create).toHaveBeenCalledTimes(1);
    const params = issues.create.mock.calls[0][0];
    expect(params.title).toBe(ISSUE_TITLE);
    expect(params.labels).toEqual([PROJECT_URL_FAILURE_LABEL]);
    expect(params.body).toContain(ISSUE_MARKER);
    expect(params.body).toContain(RUN_URL);
  });

  it("comments on the open issue instead of opening a duplicate", async () => {
    const { github, core, issues } = buildStubs([tracked(5)]);
    await notifyProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.create).not.toHaveBeenCalled();
    expect(issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 5 }),
    );
  });

  it("ignores labeled items without the marker and pull requests", async () => {
    const { github, core, issues } = buildStubs([
      { number: 1, body: "unrelated" },
      { number: 2, body: ISSUE_MARKER, pull_request: {} },
    ]);
    await notifyProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.create).toHaveBeenCalledTimes(1);
  });

  it("lets a lookup failure surface instead of swallowing it", async () => {
    const { github, core, issues } = buildStubs();
    issues.listForRepo.mockRejectedValue(new Error("api down"));
    await expect(
      notifyProjectUrlFailure({ github, context: CONTEXT, core }),
    ).rejects.toThrow("api down");
  });
});

describe("closeResolvedProjectUrlFailure", () => {
  it("does nothing when no tracked issue is open", async () => {
    const { github, core, issues } = buildStubs();
    await closeResolvedProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.update).not.toHaveBeenCalled();
  });

  it("closes every tracked issue and comments the recovered run", async () => {
    const { github, core, issues } = buildStubs([tracked(5), tracked(6)]);
    await closeResolvedProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.update).toHaveBeenCalledTimes(2);
    expect(issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 5, state: "closed" }),
    );
    expect(issues.createComment.mock.calls[0][0].body).toContain(RUN_URL);
  });

  it("never closes an unmarked issue", async () => {
    const { github, core, issues } = buildStubs([{ number: 3, body: "x" }]);
    await closeResolvedProjectUrlFailure({ github, context: CONTEXT, core });
    expect(issues.update).not.toHaveBeenCalled();
  });

  it("keeps closing the rest, then fails loud, when one close fails", async () => {
    const { github, core, issues } = buildStubs(
      [tracked(5), tracked(6)],
      async ({ issue_number }) => {
        if (issue_number === 5) {
          throw new Error("boom");
        }
        return {};
      },
    );
    await expect(
      closeResolvedProjectUrlFailure({ github, context: CONTEXT, core }),
    ).rejects.toThrow(/#5: boom/);
    expect(issues.update).toHaveBeenCalledTimes(2);
  });

  it("only warns when the recovery comment fails after a successful close", async () => {
    const { github, core, issues } = buildStubs([tracked(5)]);
    issues.createComment.mockRejectedValue(new Error("nope"));
    await closeResolvedProjectUrlFailure({ github, context: CONTEXT, core });
    expect(core.warning).toHaveBeenCalledTimes(1);
  });
});
