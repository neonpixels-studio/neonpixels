import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const WORKFLOWS_DIR = resolve(ROOT, ".github/workflows");
const SCRIPTS_PACKAGE = "@neon-pixels/scripts";
const REUSABLE_REFERENCE =
  /^\s+uses:\s*neonpixels-studio\/packages\/\.github\/workflows\/(\S+?)@(\S+) # (\S.*)$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCRIPTS_VERSION_LINE = /^\s+scripts-version:\s*(\S+)\s*$/;

const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    lines: readFileSync(resolve(WORKFLOWS_DIR, file), "utf8").split("\n"),
  }));

const references = workflows.flatMap(({ file, lines }) =>
  lines.flatMap((line) => {
    const match = REUSABLE_REFERENCE.exec(line);
    return match
      ? [{ file, workflow: match[1], reference: match[2], comment: match[3] }]
      : [];
  }),
);

const scriptsVersions = workflows.flatMap(({ lines }) =>
  lines.flatMap((line) => {
    const match = SCRIPTS_VERSION_LINE.exec(line);
    return match ? [match[1]] : [];
  }),
);

const installedScriptsVersion = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    .devDependencies as Record<string, string>
)[SCRIPTS_PACKAGE];

describe("shared reusable workflows", () => {
  it("calls gitleaks, dependency-audit, lighthouse, and production-deploy", () => {
    expect(references.map((entry) => entry.workflow).sort()).toEqual([
      "dependency-audit.yml",
      "gitleaks.yml",
      "lighthouse.yml",
      "production-deploy.yml",
    ]);
  });

  it("pins every reusable workflow to a full commit SHA with a trailing comment", () => {
    for (const entry of references) {
      expect(entry.reference, entry.file).toMatch(FULL_COMMIT_SHA);
    }
  });

  it("uses the same commit for every reusable workflow", () => {
    expect(new Set(references.map((entry) => entry.reference)).size).toBe(1);
  });
});

describe("@neon-pixels/scripts version", () => {
  it("is a dev dependency at an exact version", () => {
    expect(installedScriptsVersion).toMatch(EXACT_VERSION);
  });

  it("matches every scripts-version workflow input", () => {
    expect(scriptsVersions.length).toBeGreaterThanOrEqual(3);
    expect(new Set(scriptsVersions)).toEqual(
      new Set([installedScriptsVersion]),
    );
  });
});
