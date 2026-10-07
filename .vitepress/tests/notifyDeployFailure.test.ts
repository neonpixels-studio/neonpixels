import { describe, it, expect, vi } from "vitest";

import notifyDeployFailure from "../../.github/scripts/notify-deploy-failure.cjs";

// Mirrors notifyAuditFailure.test.ts: the duplicate guard is driven against
// a stubbed github client.

const { DEPLOY_FAILURE_LABEL, ISSUE_TITLE, ISSUE_MARKER } = notifyDeployFailure;

const CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 7,
};

function run(
  existingIssues: { number: number; body?: string; pull_request?: unknown }[],
) {
  const issues = {
    listForRepo: vi.fn().mockResolvedValue({ data: existingIssues }),
    create: vi.fn().mockResolvedValue({ data: { number: 50 } }),
    createComment: vi.fn().mockResolvedValue({}),
  };
  const core = { info: vi.fn() };
  const done = notifyDeployFailure({
    github: { rest: { issues } },
    context: CONTEXT,
    core,
  });
  return { issues, done };
}

describe("notify-deploy-failure", () => {
  it("opens a labeled, marked issue linking the run when none is open", async () => {
    const { issues, done } = run([]);
    await done;
    expect(issues.create).toHaveBeenCalledTimes(1);
    const params = issues.create.mock.calls[0][0];
    expect(params.title).toBe(ISSUE_TITLE);
    expect(params.labels).toEqual([DEPLOY_FAILURE_LABEL]);
    expect(params.body).toContain(ISSUE_MARKER);
    expect(params.body).toContain(
      "https://github.com/neonpixels-studio/neonpixels/actions/runs/7",
    );
  });

  it("comments instead of duplicating when a tracked issue is open", async () => {
    const { issues, done } = run([{ number: 12, body: ISSUE_MARKER }]);
    await done;
    expect(issues.create).not.toHaveBeenCalled();
    expect(issues.createComment.mock.calls[0][0].issue_number).toBe(12);
  });

  it("ignores labeled items without the marker and pull requests", async () => {
    const { issues, done } = run([
      { number: 1, body: "unrelated" },
      { number: 2, body: ISSUE_MARKER, pull_request: {} },
    ]);
    await done;
    expect(issues.create).toHaveBeenCalledTimes(1);
    expect(issues.createComment).not.toHaveBeenCalled();
  });
});
