import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The hook must not block commits when gitleaks is missing (CI runs it
// regardless), but must still fail the commit when gitleaks reports findings.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const HOOK_PATH = path.join(REPO_ROOT, ".husky/pre-commit");
const SHELL_PATH = "/bin/sh";

let binDirectory: string;

function runHook() {
  return spawnSync(SHELL_PATH, [HOOK_PATH], {
    cwd: REPO_ROOT,
    env: { PATH: binDirectory },
    encoding: "utf-8",
  });
}

function installStubGitleaks(exitCode: number) {
  const stubPath = path.join(binDirectory, "gitleaks");
  writeFileSync(
    stubPath,
    `#!/bin/sh\necho "stub gitleaks $*"\nexit ${exitCode}\n`,
  );
  chmodSync(stubPath, 0o755);
}

describe("husky pre-commit hook", () => {
  beforeEach(() => {
    binDirectory = mkdtempSync(path.join(tmpdir(), "gitleaks-hook-"));
  });

  afterEach(() => {
    rmSync(binDirectory, { recursive: true, force: true });
  });

  it("warns and exits 0 when gitleaks is not installed", () => {
    const result = runHook();

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("gitleaks is not installed");
    expect(result.stderr).toContain("SKIPPED");
    expect(result.stderr).toContain("brew install gitleaks");
    expect(result.stderr).toContain("pull requests");
  });

  it("passes when gitleaks finds nothing", () => {
    installStubGitleaks(0);

    const result = runHook();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "stub gitleaks git --staged --redact --config .gitleaks.toml",
    );
    expect(result.stderr).not.toContain("SKIPPED");
  });

  it("blocks the commit when gitleaks reports findings", () => {
    installStubGitleaks(1);

    const result = runHook();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "stub gitleaks git --staged --redact --config .gitleaks.toml",
    );
  });
});
