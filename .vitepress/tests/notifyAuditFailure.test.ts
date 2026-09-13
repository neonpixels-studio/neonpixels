import { describe, it, expect, vi } from "vitest";

import notifyAuditFailure from "../../.github/scripts/notify-audit-failure.js";
import type { GithubIssueOrPullRequest } from "../../.github/scripts/notify-audit-failure.js";

// notify-audit-failure.js is the module the "Notify on scheduled audit
// failure" step (.github/workflows/security.yml) requires at runtime via
// actions/github-script. Extracted out of the YAML `script:` block
// specifically so its duplicate-guard logic — the part with an actual
// failure mode — can be driven against a stubbed `github` client here,
// rather than only pattern-matched as source text (see securityWorkflow.test.ts,
// which covers the surrounding YAML wiring instead).

const REPO_CONTEXT = {
  repo: { owner: "neonpixels-studio", repo: "neonpixels" },
  serverUrl: "https://github.com",
  runId: 42,
};

function buildGithubStub({
  existingIssues = [] as GithubIssueOrPullRequest[],
} = {}) {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: existingIssues }),
        create: vi.fn().mockResolvedValue({ data: { number: 99 } }),
      },
    },
  };
}

function buildCoreStub() {
  return { info: vi.fn() };
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
    expect(createArgs.labels).toEqual(["audit-failure"]);
    expect(createArgs.body).toContain(
      "https://github.com/neonpixels-studio/neonpixels/actions/runs/42",
    );
  });

  it("skips creating an issue when an open audit-failure issue already exists", async () => {
    const github = buildGithubStub({
      existingIssues: [{ number: 7, pull_request: undefined }],
    });
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
      existingIssues: [{ number: 3, pull_request: { url: "..." } }],
    });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  it("creates an issue when only a pull request matches but no real issue does", async () => {
    const github = buildGithubStub({
      existingIssues: [
        { number: 3, pull_request: { url: "..." } },
        { number: 8, pull_request: undefined },
      ],
    });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    // The real issue (#8) is the match; the PR (#3) must not mask it.
    expect(github.rest.issues.create).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("#8"));
  });

  it("scopes the lookup to the open, audit-failure-labeled issue set", async () => {
    const github = buildGithubStub({ existingIssues: [] });
    const core = buildCoreStub();

    await notifyAuditFailure({ github, context: REPO_CONTEXT, core });

    expect(github.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "neonpixels-studio",
        repo: "neonpixels",
        state: "open",
        labels: "audit-failure",
      }),
    );
  });
});
