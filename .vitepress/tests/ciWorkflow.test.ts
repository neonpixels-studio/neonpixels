import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SMOKE_BUILD_REUSE_DIR_ENV } from "./utils/buildReuse";

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
    expect(permissions.match(/^\s+\S+:/gm) ?? []).toHaveLength(1);
  });

  // The change-detection job is the one exception: dorny/paths-filter lists
  // PR files through the API, which needs pull-requests: read once the repo
  // is private. Every other job inherits the top-level contents: read.
  it("has no job-level permissions override outside the changes job", () => {
    const jobs = findTopLevelBlock("jobs") ?? "";
    const withoutChangesJob = jobs.replace(
      /^ {2}changes:[\s\S]*?(?=^ {2}\S)/m,
      "",
    );
    expect(withoutChangesJob).not.toMatch(/^\s+permissions:/m);
  });
});

describe("ci.yml concurrency", () => {
  const concurrency = () => findTopLevelBlock("concurrency") ?? "";

  it("declares a top-level concurrency block", () => {
    expect(findTopLevelBlock("concurrency")).not.toBeUndefined();
  });

  it("groups runs per PR number, falling back to the commit SHA", () => {
    expect(concurrency()).toMatch(
      /^\s+group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|\s*github\.sha\s*\}\}\s*$/m,
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

describe("ci.yml internal link check", () => {
  it("runs link:check after the build step", () => {
    const build = WORKFLOW.indexOf("run: npm run build");
    const linkCheck = WORKFLOW.indexOf("run: npm run link:check");
    expect(build).toBeGreaterThan(-1);
    expect(linkCheck).toBeGreaterThan(build);
  });
});

describe("ci.yml single site build", () => {
  const BUILD_COMMAND = "run: npm run build";
  const TEST_COMMAND = "run: npm run test:ci";
  const BUILD_STEP_LINE = /^\s+run:\s*npm run build\s*$/gm;
  const PUBLISH_DIR_PATTERN = "\\.vitepress/dist";

  it("builds the site before running test:ci so the smoke suite can reuse it", () => {
    const build = WORKFLOW.indexOf(BUILD_COMMAND);
    const test = WORKFLOW.indexOf(TEST_COMMAND);
    expect(build).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(build);
  });

  it("builds only once", () => {
    expect(WORKFLOW.match(BUILD_STEP_LINE)).toHaveLength(1);
    expect(WORKFLOW).not.toMatch(/vitepress build/);
  });

  it("passes SMOKE_BUILD_REUSE_DIR pointing at the publish dir to the test step", () => {
    const testStart = WORKFLOW.indexOf(TEST_COMMAND);
    const nextStep = WORKFLOW.slice(testStart).search(/\n\s+- (?:name|uses):/);
    const testStep = WORKFLOW.slice(
      testStart,
      nextStep === -1 ? undefined : testStart + nextStep,
    );
    expect(testStep).toMatch(
      new RegExp(
        `^\\s+${SMOKE_BUILD_REUSE_DIR_ENV}:\\s*["']?${PUBLISH_DIR_PATTERN}["']?\\s*$`,
        "m",
      ),
    );
  });
});
