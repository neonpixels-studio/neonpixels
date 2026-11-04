import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Line-scoped YAML assertions, as in securityWorkflow.test.ts (no YAML parser
// is a project dependency). The issue logic is covered in
// projectUrlCheckIssue.test.ts; this covers the wiring.
const WORKFLOW = readFileSync(
  resolve(process.cwd(), ".github/workflows/project-url-check.yml"),
  "utf8",
);
const FULL_SHA_PINNED_USES =
  /^\s*(?:-\s*)?uses:\s*\S+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/;

function readJob(name: string) {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) {
    throw new Error(`no ${name} job`);
  }
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^ {2}\S+:\s*$/.test(line));
  return rest
    .slice(0, next === -1 ? rest.length : next)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("project-url-check.yml", () => {
  it("runs on a schedule and on manual dispatch", () => {
    expect(WORKFLOW).toMatch(/^ {2}schedule:\s*$/m);
    expect(WORKFLOW).toMatch(/- cron: "[^"]+"/);
    expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it("pins every action to a full commit SHA with a version comment", () => {
    const usesLines = WORKFLOW.split("\n").filter((line) =>
      /^\s*(?:-\s*)?uses:/.test(line),
    );
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(FULL_SHA_PINNED_USES);
    }
  });

  it("checks URLs with the script, in a job without issues: write", () => {
    const job = readJob("check");
    expect(job).toContain("node .vitepress/health/checkProjectUrls.ts");
    expect(job).not.toContain("issues: write");
    expect(job).not.toContain("npm ci");
  });

  it("notifies only on scheduled failure, with issues: write", () => {
    const job = readJob("notify-project-url-failure");
    expect(job).toContain("needs: check");
    expect(job).toContain("failure() && github.event_name == 'schedule'");
    expect(job).toContain("issues: write");
    expect(job).toContain("notifyProjectUrlFailure");
  });

  it("closes only on scheduled success, with issues: write", () => {
    const job = readJob("close-resolved-project-url-failure");
    expect(job).toContain("needs: check");
    expect(job).toContain("success() && github.event_name == 'schedule'");
    expect(job).toContain("issues: write");
    expect(job).toContain("closeResolvedProjectUrlFailure");
  });
});
