import { describe, it, expect, vi } from "vitest";

import notifyAuditFailure from "../../.github/scripts/notify-audit-failure.cjs";
import type { GithubIssueOrPullRequest } from "../../.github/scripts/notify-audit-failure.cjs";

// notify-audit-failure.cjs is the module the "Notify on scheduled audit
// failure" step (.github/workflows/security.yml) requires at runtime via
// actions/github-script. Extracted out of the YAML `script:` block
// specifically so its duplicate-guard logic — the part with an actual
// failure mode — can be driven against a stubbed `github` client here,
// rather than only pattern-matched as source text (see securityWorkflow.test.ts,
// which covers the surrounding YAML wiring instead).

const { AUDIT_FAILURE_LABEL, ISSUE_TITLE } = notifyAuditFailure;

const REPO_CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 42,
};

type GithubStubOptions = {
  existingIssues?: GithubIssueOrPullRequest[];
  listForRepoImpl?: () => Promise<{ data: GithubIssueOrPullRequest[] }>;
  createImpl?: () => Promise<{ data: { number: number } }>;
};

function buildGithubStub({
  existingIssues = [],
  listForRepoImpl,
  createImpl,
}: GithubStubOptions = {}) {
  return {
    rest: {
      issues: {
        listForRepo: listForRepoImpl
          ? vi.fn().mockImplementation(listForRepoImpl)
          : vi.fn().mockResolvedValue({ data: existingIssues }),
        create: createImpl
          ? vi.fn().mockImplementation(createImpl)
          : vi.fn().mockResolvedValue({ data: { number: 99 } }),
      },
    },
  };
}

function buildCoreStub() {
  return { info: vi.fn() };
}

function trackedIssue(number: number) {
  return { number, title: ISSUE_TITLE, pull_request: undefined };
}

describe("notifyAuditFailure", () => {
  it("creates an issue when no open audit-failure issue exists", async () => {
    const github = buildGithubStub({ existingIssues: [] });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.create).toHaveBeenCalledTimes(1);
    const [createArgs] = github.rest.issues.create.mock.calls[0];
    expect(createArgs.owner).toBe("neonpixels-studio");
    expect(createArgs.repo).toBe("neonpixels");
    expect(createArgs.title).toBe(ISSUE_TITLE);
    expect(createArgs.labels).toEqual([AUDIT_FAILURE_LABEL]);
    expect(createArgs.body).toContain(
      "https://github.com/neonpixels-studio/neonpixels/actions/runs/42",
    );
  });

  it("logs the created issue number on success", async () => {
    const github = buildGithubStub({ existingIssues: [] });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("#99"));
  });

  it("skips creating an issue when an open audit-failure issue already exists", async () => {
    const github = buildGithubStub({ existingIssues: [trackedIssue(7)] });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.create).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("#7"));
  });

  // GET /repos/{owner}/{repo}/issues (what listForRepo wraps) returns pull
  // requests alongside issues. A PR that happens to carry the audit-failure
  // label (e.g. tagged for unrelated triage) must not be mistaken for an
  // existing notification and permanently suppress real ones.
  it("ignores pull requests carrying the audit-failure label", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 3, title: ISSUE_TITLE, pull_request: { url: "..." } },
      ],
    });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  // The label alone isn't a reliable match — an unrelated issue could carry
  // it during manual triage. Only an issue with both the label AND the exact
  // title this script creates should suppress a new notification.
  it("ignores an open issue with the label but a different title", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 5, title: "Unrelated issue", pull_request: undefined },
      ],
    });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  it("creates an issue when only a pull request matches but no real issue does", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 3, title: ISSUE_TITLE, pull_request: { url: "..." } },
        trackedIssue(8),
      ],
    });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    // The real issue (#8) is the match; the PR (#3) must not mask it.
    expect(github.rest.issues.create).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("#8"));
  });

  it("scopes the lookup to the open, audit-failure-labeled issue set at the API's max page size", async () => {
    const github = buildGithubStub({ existingIssues: [] });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "neonpixels-studio",
        repo: "neonpixels",
        state: "open",
        labels: AUDIT_FAILURE_LABEL,
        per_page: 100,
      }),
    );
  });

  // Fail-loud: a broken notifier (bad token, disabled issues, transient API
  // error) should surface as a visible workflow failure, not be swallowed —
  // silence is exactly the failure mode this feature exists to eliminate.
  it("propagates an error from the duplicate check instead of swallowing it", async () => {
    const github = buildGithubStub({
      listForRepoImpl: () => Promise.reject(new Error("API unavailable")),
    });
    const core = buildCoreStub();

    await expect(
      notifyAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("API unavailable");
    expect(github.rest.issues.create).not.toHaveBeenCalled();
  });

  it("propagates an error from issue creation instead of swallowing it", async () => {
    const github = buildGithubStub({
      existingIssues: [],
      createImpl: () => Promise.reject(new Error("issues disabled")),
    });
    const core = buildCoreStub();

    await expect(
      notifyAuditFailure({ github, context: REPO_CONTEXT, core }),
    ).rejects.toThrow("issues disabled");
  });
});
