import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// No YAML parser is a project dependency (see netlify.test.ts, which parses
// TOML the same way), so this file line-scopes the `audit:` job the way that
// file line-scopes [build]/[[headers]] tables, rather than pulling in a
// parser for one file. The duplicate-guard behavior this workflow step
// depends on lives in .github/scripts/notify-audit-failure.cjs and is unit-
// tested against a stubbed github client in notifyAuditFailure.test.ts; this
// file only covers the YAML wiring (permissions, triggers, which script runs).
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

const PERMISSIONS_LINE = /^ {4}permissions:\s*$/m;

// Slices to the audit job's own `permissions:` block (4-space indent, keys
// nested one level deeper at 6 spaces), stopping at the next 4-space-indented
// key. Bounds assertions to the block itself, not anywhere else in the job
// (e.g. a `with:` map that happens to contain a same-named key).
function readAuditJobPermissions(jobBlock: string) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => PERMISSIONS_LINE.test(line));
  if (start === -1) {
    throw new Error("audit job has no `permissions:` block");
  }
  const rest = lines.slice(start + 1);
  const nextKey = rest.findIndex((line) => /^ {4}\S+:\s*$/.test(line));
  const end = nextKey === -1 ? rest.length : nextKey;
  return rest.slice(0, end).join("\n");
}

const STEP_NAME_LINE = /^\s*-\s*name:\s*(.+?)\s*$/m;

// Slices to a single named step within a job block, the same bounded-window
// approach as readBuildTable()/readGlobalHeadersTable() in netlify.test.ts:
// stop at the next `- name:` line so a later step's fields can't leak into
// this one's assertions. Returns undefined (rather than throwing) when the
// step isn't found, so a test that specifically checks for the step's
// existence gets a real assertion failure instead of every test in the file
// being aborted by a throw during setup.
function findStep(jobBlock: string, name: string) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => {
    const match = line.match(STEP_NAME_LINE);
    return match?.[1] === name;
  });
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const nextStep = rest.findIndex((line) => STEP_NAME_LINE.test(line));
  const end = nextStep === -1 ? rest.length : nextStep;
  return rest.slice(0, end).join("\n");
}

// Throwing variant for callers that need the step to exist in order to make
// any further assertion (e.g. beforeAll below, where every test in the
// describe block already depends on the step being present).
function readStep(jobBlock: string, name: string) {
  const step = findStep(jobBlock, name);
  if (step === undefined) {
    throw new Error(`No step named "${name}" found`);
  }
  return step;
}

describe("audit job permissions", () => {
  const auditPermissions = readAuditJobPermissions(AUDIT_JOB);

  it("declares its own permissions block", () => {
    expect(AUDIT_JOB).toMatch(PERMISSIONS_LINE);
  });

  it("grants issues: write, scoped to this job", () => {
    expect(auditPermissions).toMatch(/^\s*issues:\s*write\s*$/m);
  });

  it("keeps contents: read (job permissions replace, not add to, the default)", () => {
    expect(auditPermissions).toMatch(/^\s*contents:\s*read\s*$/m);
  });

  // The security-relevant property is that issues: write is scoped to the
  // audit job alone, not merely that it appears somewhere in the file — it
  // would satisfy a looser check just as well if hoisted onto the
  // workflow-level default (line 19-20) or added to the gitleaks job, which
  // has no need to open issues.
  it("does not grant issues: write outside the audit job", () => {
    const withoutAuditJob = WORKFLOW.replace(AUDIT_JOB, "");
    expect(withoutAuditJob).not.toMatch(/^\s*issues:\s*write\s*$/m);
  });
});

describe("notify on scheduled audit failure", () => {
  const NOTIFY_STEP_NAME = "Notify on scheduled audit failure";
  const GATE_STEP_NAME = "Audit gate (fail on high or critical advisories)";

  // Resolved lazily in beforeAll (via the throwing readStep) rather than at
  // describe-body/module scope, so a rename/removal fails inside a test
  // instead of aborting collection for the whole file. The existence check
  // itself below uses the non-throwing findStep so it still reports a real
  // assertion failure rather than being taken out by the same beforeAll it's
  // meant to diagnose.
  let notifyStep = "";
  let gateStep = "";

  beforeAll(() => {
    gateStep = readStep(AUDIT_JOB, GATE_STEP_NAME);
    notifyStep = readStep(AUDIT_JOB, NOTIFY_STEP_NAME);
  });

  it("adds a notify step to the audit job", () => {
    expect(findStep(AUDIT_JOB, NOTIFY_STEP_NAME)).not.toBeUndefined();
  });

  it("gives the audit gate step an id the notify step can reference", () => {
    expect(gateStep).toMatch(/^\s*id:\s*audit_gate\s*$/m);
  });

  it("only runs when the job failed", () => {
    expect(notifyStep).toMatch(/if:\s*\|?\s*\n?\s*failure\(\)/);
  });

  // The audit job also runs on push/pull_request, where a failure already
  // shows up as a failing required check — opening an issue there would be
  // redundant noise on top of a signal that's already visible. Only the
  // schedule trigger runs unattended.
  it("scopes the notification to the schedule trigger only", () => {
    expect(notifyStep).toMatch(/github\.event_name\s*==\s*'schedule'/);
  });

  // Job-level failure() is true if ANY earlier step failed (checkout, npm
  // ci, a registry blip), not just the audit gate. Without also checking the
  // gate step's own conclusion, an unrelated infra flake would open a
  // misleading "audit failed" issue that then blocks real ones via the
  // duplicate guard in notify-audit-failure.js.
  it("also requires the audit gate step itself to have failed", () => {
    expect(notifyStep).toMatch(
      /steps\.audit_gate\.conclusion\s*==\s*'failure'/,
    );
  });

  it("opens the issue via the GitHub API rather than a third-party action", () => {
    expect(notifyStep).toMatch(/uses:\s*actions\/github-script@/);
  });

  // The duplicate-guard logic itself (labels, open-state check, PR
  // filtering) lives in .github/scripts/notify-audit-failure.js and is
  // behavior-tested there; this only confirms the step wires up to it.
  it("delegates to the extracted, unit-tested notify script", () => {
    expect(notifyStep).toMatch(
      /require\(["']\.\/\.github\/scripts\/notify-audit-failure\.cjs["']\)/,
    );
  });
});
