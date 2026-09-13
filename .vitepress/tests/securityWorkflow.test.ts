import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// No YAML parser is a project dependency (see netlify.test.ts, which parses
// TOML the same way), so this file line-scopes the `audit:` job the way that
// file line-scopes [build]/[[headers]] tables, rather than pulling in a
// parser for one file.
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/security.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

const TOP_LEVEL_KEY = /^\S/;
const JOB_LINE = /^ {2}audit:\s*$/;

// Slices from the `audit:` job line to the next top-level-indented job key (or
// end of file), so assertions about the audit job's permissions/steps can't
// accidentally match the gitleaks job above it.
function readAuditJob() {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((line) => JOB_LINE.test(line));
  if (start === -1) {
    throw new Error("security.yml has no `audit:` job");
  }
  const rest = lines.slice(start + 1);
  const nextJob = rest.findIndex(
    (line) => TOP_LEVEL_KEY.test(line) || /^ {2}\S+:\s*$/.test(line),
  );
  const end = nextJob === -1 ? rest.length : nextJob;
  return rest.slice(0, end).join("\n");
}

const AUDIT_JOB = readAuditJob();

const STEP_NAME_LINE = /^\s*-\s*name:\s*(.+?)\s*$/m;

// Slices to a single named step within a job block, the same bounded-window
// approach as readBuildTable()/readGlobalHeadersTable() in netlify.test.ts:
// stop at the next `- name:` line so a later step's fields can't leak into
// this one's assertions.
function readStep(jobBlock: string, name: string) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => {
    const match = line.match(STEP_NAME_LINE);
    return match?.[1] === name;
  });
  if (start === -1) {
    throw new Error(`No step named "${name}" found`);
  }
  const rest = lines.slice(start + 1);
  const nextStep = rest.findIndex((line) => STEP_NAME_LINE.test(line));
  const end = nextStep === -1 ? rest.length : nextStep;
  return rest.slice(0, end).join("\n");
}

describe("audit job permissions", () => {
  it("declares its own permissions block", () => {
    expect(AUDIT_JOB).toMatch(/^ {4}permissions:\s*$/m);
  });

  it("grants issues: write, scoped to this job", () => {
    expect(AUDIT_JOB).toMatch(/^\s*issues:\s*write\s*$/m);
  });

  it("keeps contents: read (job permissions replace, not add to, the default)", () => {
    expect(AUDIT_JOB).toMatch(/^\s*contents:\s*read\s*$/m);
  });
});

describe("notify on scheduled audit failure", () => {
  const NOTIFY_STEP_NAME = "Notify on scheduled audit failure";

  it("adds a notify step to the audit job", () => {
    expect(AUDIT_JOB).toMatch(STEP_NAME_LINE);
    expect(() => readStep(AUDIT_JOB, NOTIFY_STEP_NAME)).not.toThrow();
  });

  const notifyStep = readStep(AUDIT_JOB, NOTIFY_STEP_NAME);

  it("only runs when the job failed", () => {
    const ifLine = notifyStep.match(/^\s*if:\s*(.+)$/m)?.[1] ?? "";
    expect(ifLine).toContain("failure()");
  });

  // The audit job also runs on push/pull_request, where a failure already
  // shows up as a failing required check — opening an issue there would be
  // redundant noise on top of a signal that's already visible. Only the
  // schedule trigger runs unattended.
  it("scopes the notification to the schedule trigger only", () => {
    const ifLine = notifyStep.match(/^\s*if:\s*(.+)$/m)?.[1] ?? "";
    expect(ifLine).toMatch(/github\.event_name\s*==\s*'schedule'/);
  });

  it("opens the issue via the GitHub API rather than a third-party action", () => {
    expect(notifyStep).toMatch(/uses:\s*actions\/github-script@/);
  });

  it("creates the issue with a stable label for the duplicate guard", () => {
    expect(notifyStep).toMatch(/labels:\s*\[label\]/);
    expect(notifyStep).toMatch(/const label = "audit-failure"/);
  });

  it("checks for an existing open issue before creating a new one", () => {
    expect(notifyStep).toMatch(/issues\.listForRepo/);
    expect(notifyStep).toMatch(/state:\s*"open"/);
    // The guard must actually stop execution when a match is found, not just
    // look one up and ignore the result.
    expect(notifyStep).toMatch(/openAuditFailures\.length > 0/);
    expect(notifyStep).toMatch(/return;/);
  });

  it("creates the issue only after the duplicate check", () => {
    const listIndex = notifyStep.indexOf("issues.listForRepo");
    const createIndex = notifyStep.indexOf("issues.create");
    expect(listIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(listIndex);
  });
});
