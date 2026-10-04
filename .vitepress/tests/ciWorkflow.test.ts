import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Line-scoped like securityWorkflow.test.ts: no YAML parser is a project
// dependency, so top-level blocks are sliced by indentation.
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/ci.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

const TOP_LEVEL_KEY = /^[^\s#]/;

// Slices a top-level `<name>:` block up to the next top-level key. Returns
// undefined when absent so the assertion fails rather than setup throwing.
function findTopLevelBlock(name: string) {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^${name}:\\s*$`).test(line),
  );
  if (start === -1) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => TOP_LEVEL_KEY.test(line));
  const end = next === -1 ? rest.length : next;
  return rest.slice(0, end).join("\n");
}

describe("ci.yml permissions", () => {
  it("declares a top-level permissions block", () => {
    expect(findTopLevelBlock("permissions")).not.toBeUndefined();
  });

  it("grants only contents: read", () => {
    const permissions = findTopLevelBlock("permissions") ?? "";
    expect(permissions).toMatch(/^\s+contents:\s*read\s*$/m);
    expect(permissions.match(/^\s+\S+:/gm)).toHaveLength(1);
  });

  it("has no job-level permissions override", () => {
    const jobs = findTopLevelBlock("jobs") ?? "";
    expect(jobs).not.toMatch(/^\s+permissions:/m);
  });
});

describe("ci.yml concurrency", () => {
  const concurrency = () => findTopLevelBlock("concurrency") ?? "";

  it("declares a top-level concurrency block", () => {
    expect(findTopLevelBlock("concurrency")).not.toBeUndefined();
  });

  it("groups runs per PR number, falling back to the commit SHA", () => {
    expect(concurrency()).toMatch(
      /^\s+group:\s*.*github\.event\.pull_request\.number\s*\|\|\s*github\.sha\b/m,
    );
  });

  // Unconditional `true` would cancel in-flight main builds when a second
  // merge lands, dropping that commit's build result.
  it("cancels in-progress runs only for pull_request events", () => {
    expect(concurrency()).toMatch(
      /^\s+cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}\s*$/m,
    );
  });
});
