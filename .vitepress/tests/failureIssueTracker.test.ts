import { describe, expect, it, vi } from "vitest";

import { createFailureIssueTracker } from "../../.github/scripts/failure-issue-tracker.cjs";
import type {
  TrackerGithub,
  TrackerIssueOrPullRequest,
} from "../../.github/scripts/failure-issue-tracker.cjs";

const MARKER = "<!-- test:tracker -->";
const LABEL = "test-failure";
const RUN_URL = "https://github.com/o/r/actions/runs/42";

const context = {
  repo: { owner: "o", repo: "r" },
  serverUrl: "https://github.com",
  runId: 42,
};

function createTracker() {
  return createFailureIssueTracker({
    label: LABEL,
    marker: MARKER,
    title: "Test failed",
    logName: "test-failure",
    buildIssueBody: (runUrl) => `${MARKER}\nbody ${runUrl}`,
    buildRecoveryComment: (runUrl) => `recovered ${runUrl}`,
  });
}

function createStubs(openItems: TrackerIssueOrPullRequest[] = []) {
  const issues = {
    listForRepo: vi.fn().mockResolvedValue({ data: openItems }),
    create: vi.fn().mockResolvedValue({ data: { number: 99 } }),
    update: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
  };
  const github = { rest: { issues } } as unknown as TrackerGithub;
  const core = { info: vi.fn(), warning: vi.fn() };
  return { issues, github, core };
}

const tracked = (number: number) => ({ number, body: `${MARKER}\nx` });

describe("findOpenIssues", () => {
  it("queries open issues by label at max page size", async () => {
    const { issues, github } = createStubs();
    await createTracker().findOpenIssues({ github, owner: "o", repo: "r" });
    expect(issues.listForRepo).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      state: "open",
      labels: LABEL,
      per_page: 100,
    });
  });

  it("ignores pull requests, unmarked issues, and null bodies", async () => {
    const { github } = createStubs([
      tracked(1),
      { number: 2, body: MARKER, pull_request: {} },
      { number: 3, body: "no marker" },
      { number: 4, body: null },
    ]);
    const found = await createTracker().findOpenIssues({
      github,
      owner: "o",
      repo: "r",
    });
    expect(found.map((issue) => issue.number)).toEqual([1]);
  });
});

describe("notify", () => {
  it("opens an issue with title, label, and body when none is open", async () => {
    const { issues, github, core } = createStubs();
    await createTracker().notify({ github, context, core });
    expect(issues.create).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      title: "Test failed",
      labels: [LABEL],
      body: `${MARKER}\nbody ${RUN_URL}`,
    });
    expect(issues.createComment).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith("Opened test-failure issue #99.");
  });

  it("comments on the first open issue instead of duplicating", async () => {
    const { issues, github, core } = createStubs([tracked(7), tracked(8)]);
    await createTracker().notify({ github, context, core });
    expect(issues.create).not.toHaveBeenCalled();
    expect(issues.createComment).toHaveBeenCalledTimes(1);
    expect(issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 7,
      body: `Still failing. Latest run: ${RUN_URL}`,
    });
  });

  it("opens a new issue when the only labeled item is a PR", async () => {
    const { issues, github, core } = createStubs([
      { number: 5, body: MARKER, pull_request: {} },
    ]);
    await createTracker().notify({ github, context, core });
    expect(issues.create).toHaveBeenCalledTimes(1);
  });

  it("propagates lookup errors", async () => {
    const { issues, github, core } = createStubs();
    issues.listForRepo.mockRejectedValue(new Error("boom"));
    await expect(
      createTracker().notify({ github, context, core }),
    ).rejects.toThrow("boom");
  });
});

describe("closeResolved", () => {
  it("does nothing when no tracked issue is open", async () => {
    const { issues, github, core } = createStubs();
    await createTracker().closeResolved({ github, context, core });
    expect(issues.update).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      "No open test-failure issue to close.",
    );
  });

  it("closes every tracked issue and posts the recovery comment", async () => {
    const { issues, github, core } = createStubs([tracked(1), tracked(2)]);
    await createTracker().closeResolved({ github, context, core });
    expect(issues.update).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      state: "closed",
    });
    expect(issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 2, state: "closed" }),
    );
    expect(issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: `recovered ${RUN_URL}`,
    });
    expect(issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 2,
        body: `recovered ${RUN_URL}`,
      }),
    );
    expect(issues.createComment).toHaveBeenCalledTimes(2);
  });

  it("only warns when the recovery comment fails after a successful close", async () => {
    const { issues, github, core } = createStubs([tracked(1)]);
    issues.createComment.mockRejectedValue(new Error("nope"));
    await createTracker().closeResolved({ github, context, core });
    expect(issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 1, state: "closed" }),
    );
    expect(issues.update.mock.invocationCallOrder[0]).toBeLessThan(
      issues.createComment.mock.invocationCallOrder[0],
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("could not post the recovery comment: nope"),
    );
  });

  it("keeps closing the rest, then throws, when one close fails", async () => {
    const { issues, github, core } = createStubs([tracked(1), tracked(2)]);
    issues.update.mockRejectedValueOnce(new Error("api down"));
    await expect(
      createTracker().closeResolved({ github, context, core }),
    ).rejects.toThrow("Failed to close test-failure issue(s): #1: api down");
    expect(issues.update).toHaveBeenCalledTimes(2);
    expect(issues.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ issue_number: 2 }),
    );
  });
});
