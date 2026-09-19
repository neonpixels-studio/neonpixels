import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// No YAML parser is a project dependency (see netlify.test.ts, which parses
// TOML the same way), so this file line-scopes individual jobs the way that
// file line-scopes [build]/[[headers]] tables, rather than pulling in a
// parser for one file. The duplicate-guard behavior the notify job's script
// depends on lives in .github/scripts/notify-audit-failure.cjs and is
// unit-tested against a stubbed github client in notifyAuditFailure.test.ts;
// this file only covers the YAML wiring (jobs, permissions, triggers, which
// script runs).
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/security.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

const TOP_LEVEL_KEY = /^\S/;

// Slices from a `<name>:` job line (2-space indent) to the next
// top-level-indented key or job key (or end of file), so assertions about
// one job's permissions/steps can't accidentally match another job. Returns
// undefined (rather than throwing) when the job isn't found, so a test that
// specifically checks for the job's existence gets a real assertion failure
// instead of every test in the file being aborted by a throw during setup
// or collection.
function findJob(name: string) {
  const jobLine = new RegExp(`^ {2}${name}:\\s*$`);
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((line) => jobLine.test(line));
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const nextJob = rest.findIndex(
    (line) => TOP_LEVEL_KEY.test(line) || /^ {2}\S+:\s*$/.test(line),
  );
  const end = nextJob === -1 ? rest.length : nextJob;
  return rest.slice(0, end).join("\n");
}

// Throwing variant for callers that need the job to exist in order to make
// any further assertion (e.g. beforeAll below, where every test in a describe
// block already depends on the job being present).
function readJob(name: string) {
  const job = findJob(name);
  if (job === undefined) {
    throw new Error(`security.yml has no \`${name}:\` job`);
  }
  return job;
}

const PERMISSIONS_LINE = /^ {4}permissions:\s*$/m;

// Slices to a job's own `permissions:` block (4-space indent, keys nested
// one level deeper at 6 spaces), stopping at the next 4-space-indented key.
// Bounds assertions to the block itself, not anywhere else in the job (e.g.
// a `with:` map that happens to contain a same-named key).
function findJobPermissions(jobBlock: string) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => PERMISSIONS_LINE.test(line));
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const nextKey = rest.findIndex((line) => /^ {4}\S+:\s*$/.test(line));
  const end = nextKey === -1 ? rest.length : nextKey;
  return rest.slice(0, end).join("\n");
}

function readJobPermissions(jobBlock: string) {
  const permissions = findJobPermissions(jobBlock);
  if (permissions === undefined) {
    throw new Error("job has no `permissions:` block");
  }
  return permissions;
}

const STEP_NAME_LINE = /^\s*-\s*name:\s*(.+?)\s*$/m;

// Slices to a single named step within a job block, the same bounded-window
// approach as readBuildTable()/readGlobalHeadersTable() in netlify.test.ts:
// stop at the next `- name:` line so a later step's fields can't leak into
// this one's assertions. Non-throwing for the same reason as findJob above.
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

function readStep(jobBlock: string, name: string) {
  const step = findStep(jobBlock, name);
  if (step === undefined) {
    throw new Error(`No step named "${name}" found`);
  }
  return step;
}

describe("audit job", () => {
  // The audit job runs `npm ci`/`npm audit` over the full dependency tree,
  // including install lifecycle scripts, with GITHUB_TOKEN visible to every
  // process in the job. It must stay on the workflow-level `contents: read`
  // default rather than being handed `issues: write` — see the
  // notify-audit-failure job below, which is split out specifically to keep
  // that elevated permission away from code that runs untrusted install
  // scripts.
  it("has no job-level permissions override", () => {
    const auditJob = readJob("audit");
    expect(findJobPermissions(auditJob)).toBeUndefined();
  });
});

describe("notify-audit-failure job", () => {
  let notifyJob = "";

  beforeAll(() => {
    notifyJob = readJob("notify-audit-failure");
  });

  it("exists", () => {
    expect(findJob("notify-audit-failure")).not.toBeUndefined();
  });

  it("depends on the audit job", () => {
    expect(notifyJob).toMatch(/^\s*needs:\s*audit\s*$/m);
  });

  // The audit job also runs on push/pull_request, where a failure already
  // shows up as a failing required check — opening an issue there would be
  // redundant noise on top of a signal that's already visible. Only the
  // schedule trigger runs unattended (see issue #109).
  it("only runs on a scheduled-run failure", () => {
    const ifLine = notifyJob.match(/^\s*if:\s*(.+)$/m)?.[1] ?? "";
    expect(ifLine).toContain("failure()");
    expect(ifLine).toMatch(/github\.event_name\s*==\s*'schedule'/);
  });

  describe("permissions", () => {
    let notifyPermissions = "";

    beforeAll(() => {
      notifyPermissions = readJobPermissions(notifyJob);
    });

    it("grants issues: write, scoped to this job", () => {
      expect(notifyPermissions).toMatch(/^\s*issues:\s*write\s*$/m);
    });

    it("keeps contents: read (job permissions replace, not add to, the default)", () => {
      expect(notifyPermissions).toMatch(/^\s*contents:\s*read\s*$/m);
    });
  });

  describe("notify step", () => {
    const NOTIFY_STEP_NAME = "Notify on scheduled audit failure";
    let notifyStep = "";

    beforeAll(() => {
      notifyStep = readStep(notifyJob, NOTIFY_STEP_NAME);
    });

    it("exists", () => {
      expect(findStep(notifyJob, NOTIFY_STEP_NAME)).not.toBeUndefined();
    });

    it("opens the issue via the GitHub API rather than a third-party action", () => {
      expect(notifyStep).toMatch(/uses:\s*actions\/github-script@/);
    });

    // The duplicate-guard logic itself (label + body-marker matching,
    // PR filtering, commenting vs. creating) lives in
    // .github/scripts/notify-audit-failure.cjs and is behavior-tested
    // there; this only confirms the step wires up to it.
    it("delegates to the extracted, unit-tested notify script", () => {
      expect(notifyStep).toMatch(
        /require\(["']\.\/\.github\/scripts\/notify-audit-failure\.cjs["']\)/,
      );
    });
  });
});

describe("close-resolved-audit-failure job", () => {
  let closeJob = "";

  beforeAll(() => {
    closeJob = readJob("close-resolved-audit-failure");
  });

  it("exists", () => {
    expect(findJob("close-resolved-audit-failure")).not.toBeUndefined();
  });

  it("depends on the audit job", () => {
    expect(closeJob).toMatch(/^\s*needs:\s*audit\s*$/m);
  });

  // The audit job also runs on push/pull_request, where there's no
  // notify-audit-failure issue to close (that job only ever opens one on the
  // schedule trigger — see the "notify-audit-failure job" tests above).
  it("only runs on a scheduled-run success", () => {
    const ifLine = closeJob.match(/^\s*if:\s*(.+)$/m)?.[1] ?? "";
    expect(ifLine).toContain("success()");
    expect(ifLine).toMatch(/github\.event_name\s*==\s*'schedule'/);
  });

  describe("permissions", () => {
    let closePermissions = "";

    beforeAll(() => {
      closePermissions = readJobPermissions(closeJob);
    });

    it("grants issues: write, scoped to this job", () => {
      expect(closePermissions).toMatch(/^\s*issues:\s*write\s*$/m);
    });

    it("keeps contents: read (job permissions replace, not add to, the default)", () => {
      expect(closePermissions).toMatch(/^\s*contents:\s*read\s*$/m);
    });
  });

  describe("close step", () => {
    const CLOSE_STEP_NAME = "Close resolved audit-failure issue";
    let closeStep = "";

    beforeAll(() => {
      closeStep = readStep(closeJob, CLOSE_STEP_NAME);
    });

    it("exists", () => {
      expect(findStep(closeJob, CLOSE_STEP_NAME)).not.toBeUndefined();
    });

    it("closes the issue via the GitHub API rather than a third-party action", () => {
      expect(closeStep).toMatch(/uses:\s*actions\/github-script@/);
    });

    // The duplicate-guard lookup (label + body-marker matching, PR
    // filtering) is reused from notify-audit-failure.cjs and behavior-tested
    // in closeResolvedAuditFailure.test.ts; this only confirms the step
    // wires up to the extracted close script.
    it("delegates to the extracted, unit-tested close script", () => {
      expect(closeStep).toMatch(
        /require\(["']\.\/\.github\/scripts\/close-resolved-audit-failure\.cjs["']\)/,
      );
    });
  });
});

// The security-relevant property is that issues: write is scoped to the
// notify/close jobs alone, not merely that it appears somewhere in the file
// — it would satisfy a looser check just as well if hoisted onto the
// workflow-level default or added to the audit/gitleaks jobs, neither of
// which has any need to open or close issues. A single top-level check
// (rather than one copy nested under each job's describe block) so the
// invariant has exactly one place to update if a third job ever needs the
// permission.
it("grants issues: write only to the notify-audit-failure and close-resolved-audit-failure jobs", () => {
  const notifyJob = readJob("notify-audit-failure");
  const closeJob = readJob("close-resolved-audit-failure");
  const remainder = WORKFLOW.replace(notifyJob, "").replace(closeJob, "");
  expect(remainder).not.toMatch(/^\s*issues:\s*write\s*$/m);
});
