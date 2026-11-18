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
  const countOf = (severity: string) =>
    advisories.filter((advisory) => advisory.severity === severity).length;
  return {
    metadata: {
      vulnerabilities: {
        critical: countOf("critical"),
        high: countOf("high"),
        moderate: countOf("moderate"),
        low: countOf("low"),
      },
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
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: "",
      PATH: `${fakeBinDirectory}:${process.env.PATH}`,
    },
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
    const result = runGate(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GHSA-fc5q-39xc-vjpf@node_modules/other/node_modules/picomatch",
    );
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
    const result = runGate(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GHSA-aaaa-bbbb-cccc@node_modules/left-pad",
    );
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
    const result = runGate(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failing the build");
  });

  it("does not fail on moderate advisories", () => {
    const report = buildReport(
      [
        {
          name: "left-pad",
          severity: "moderate",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
      "node_modules/left-pad",
    );
    expect(runGate(report).status).toBe(0);
  });

  it("still blocks a second advisory next to the allowlisted one", () => {
    const report = buildReport(
      [{ name: "picomatch", severity: "high", url: PICOMATCH_ADVISORY_URL }],
      "node_modules/picomatch",
    );
    (report.vulnerabilities as Record<string, unknown>)["left-pad"] = {
      via: [
        {
          name: "left-pad",
          severity: "high",
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
      nodes: ["node_modules/left-pad"],
    };
    const result = runGate(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "GHSA-aaaa-bbbb-cccc@node_modules/left-pad",
    );
    expect(result.stderr).not.toContain("GHSA-fc5q-39xc-vjpf");
  });

  it("warns when the allowlisted advisory is no longer reported", () => {
    const result = runGate(buildReport([], "node_modules/picomatch"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Stale audit allowlist entries");
  });

  it("ignores transitive string-only via entries", () => {
    const report = buildReport(
      [{ name: "picomatch", severity: "high", url: PICOMATCH_ADVISORY_URL }],
      "node_modules/picomatch",
    );
    (report.vulnerabilities as Record<string, unknown>).vite = {
      via: ["picomatch"],
      nodes: ["node_modules/vite"],
    };
    expect(runGate(report).status).toBe(0);
  });

  it("names non-GHSA advisories by source and package", () => {
    const report = buildReport(
      [{ name: "left-pad", severity: "high", url: "https://example.com/x" }],
      "node_modules/left-pad",
    );
    (
      (report.vulnerabilities as Record<string, { via: object[] }>)["left-pad"]
        .via[0] as Record<string, unknown>
    ).source = 123;
    const result = runGate(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "source-123:left-pad@node_modules/left-pad",
    );
  });

  it("fails when npm audit returns no vulnerability metadata", () => {
    const result = runGate({ error: "registry down" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no vulnerability metadata");
  });
});
