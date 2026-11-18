import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT_PATH = resolve(process.cwd(), ".github/scripts/audit.sh");
const PICOMATCH_ADVISORY_URL =
  "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";

type AuditAdvisory = { url: string; severity: string; name: string };

function buildReport(advisories: AuditAdvisory[], nodePath: string) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const advisory of advisories) {
    vulnerabilities[advisory.name] = {
      via: [advisory],
      nodes: [nodePath],
    };
  }
  return {
    metadata: {
      vulnerabilities: { critical: 0, high: advisories.length, moderate: 0 },
    },
    vulnerabilities,
  };
}

let fakeBinDirectory: string;

// Runs audit.sh with a stub `npm` first on PATH that prints the given JSON,
// so the gate logic is tested without touching the network or node_modules.
function runGate(report: unknown) {
  const reportPath = join(fakeBinDirectory, "report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const npmStub = join(fakeBinDirectory, "npm");
  writeFileSync(npmStub, `#!/usr/bin/env bash\ncat "${reportPath}"\nexit 1\n`);
  chmodSync(npmStub, 0o755);
  return spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBinDirectory}:${process.env.PATH}` },
  });
}

describe("audit gate script", () => {
  beforeAll(() => {
    fakeBinDirectory = mkdtempSync(join(tmpdir(), "audit-gate-"));
  });

  afterAll(() => {
    rmSync(fakeBinDirectory, { recursive: true, force: true });
  });

  it("accepts the allowlisted picomatch advisory at its exact path", () => {
    const report = buildReport(
      [{ name: "picomatch", severity: "high", url: PICOMATCH_ADVISORY_URL }],
      "node_modules/picomatch",
    );
    const result = runGate(report);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No un-allowlisted high or critical");
  });

  it("fails on the picomatch advisory at a path that is not allowlisted", () => {
    const report = buildReport(
      [{ name: "picomatch", severity: "high", url: PICOMATCH_ADVISORY_URL }],
      "node_modules/other/node_modules/picomatch",
    );
    expect(runGate(report).status).toBe(1);
  });

  it("fails on any other high advisory", () => {
    const report = buildReport(
      [
        {
          name: "left-pad",
          severity: "high",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
      "node_modules/left-pad",
    );
    expect(runGate(report).status).toBe(1);
  });

  it("fails on a critical advisory", () => {
    const report = buildReport(
      [
        {
          name: "left-pad",
          severity: "critical",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
      "node_modules/left-pad",
    );
    expect(runGate(report).status).toBe(1);
  });

  it("fails when npm audit returns no vulnerability metadata", () => {
    expect(runGate({ error: "registry down" }).status).toBe(1);
  });
});
