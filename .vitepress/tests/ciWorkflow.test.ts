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

  // Two exceptions: the change-detection job (dorny/paths-filter lists PR
  // files through the API, which needs pull-requests: read once the repo is
  // private) and the lighthouse call (a reusable workflow cannot hold more
  // permissions than its caller grants, and its report job files issues).
  // Every other job inherits the top-level contents: read.
  it("has no job-level permissions override outside the changes and lighthouse jobs", () => {
    const jobs = findTopLevelBlock("jobs") ?? "";
    const withoutExceptions = jobs
      .replace(/^ {2}changes:[\s\S]*?(?=^ {2}\S)/m, "")
      .replace(/^ {2}lighthouse:[\s\S]*?(?=^ {2}\S|(?![\s\S]))/m, "");
    expect(withoutExceptions).not.toMatch(/^\s+permissions:/m);
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

const jobs = () => findTopLevelBlock("jobs") ?? "";
const findJob = (name: string) =>
  new RegExp(`^ {2}${name}:[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`, "m").exec(
    jobs(),
  )?.[0] ?? "";

describe("ci.yml e2e job", () => {
  const e2eJob = () => findJob("e2e");

  it("exists and runs the e2e script", () => {
    expect(e2eJob()).toMatch(/run: npm run e2e\s*$/m);
  });

  it("reuses the ci build artifact instead of building again", () => {
    const job = e2eJob();
    expect(job).toMatch(/needs: \[ci\]/);
    expect(job).toMatch(/name: site-build/);
    expect(job).not.toMatch(/npm run build/);
  });

  it("runs on every event, including pushes to main", () => {
    const header = e2eJob().split("steps:")[0];
    expect(header).not.toMatch(/^ {4}if:/m);
  });

  it("gets an artifact on push runs too (upload is not PR-gated)", () => {
    const ciJob = findJob("ci");
    const uploadStep = (
      ciJob.split("- name: Upload build output")[1] ?? ""
    ).split(/\n {6}- /)[0];
    expect(uploadStep).toContain("name: site-build");
    expect(uploadStep).not.toMatch(/^\s+if:/m);
  });

  it("installs only chromium", () => {
    expect(e2eJob()).toMatch(/playwright install --with-deps chromium\s*$/m);
  });
});

describe("ci.yml fallow audit", () => {
  const ciJob = () => findJob("ci");

  // A shallow checkout has no base ref, so `fallow audit` exits 2 with
  // "could not detect base branch".
  it("checks out full history so fallow can resolve a base", () => {
    expect(ciJob()).toMatch(/^\s+fetch-depth:\s*0\s*$/m);
  });

  it("runs fallow audit against an explicit base", () => {
    expect(ciJob()).toMatch(/npx fallow audit --base "\$BASE"/);
  });

  it("runs static lint before the fallow audit", () => {
    expect(ciJob()).toMatch(/npm run lint:static[\s\S]*npx fallow audit/);
  });
});

describe("ci.yml shared checks", () => {
  const ciJob = () => findJob("ci");

  it("fails the build on an unpinned action reference", () => {
    expect(ciJob()).toMatch(/run: npx np-check-action-pinning\s*$/m);
  });

  it("fails the build on drift from the synced templates", () => {
    expect(ciJob()).toMatch(
      /run: npx np-sync-templates --stack vitepress --check\s*$/m,
    );
  });

  it("runs both checks after the install that provides the bins", () => {
    const job = ciJob();
    const install = job.indexOf("run: npm ci");
    expect(install).toBeGreaterThan(-1);
    expect(job.indexOf("np-check-action-pinning")).toBeGreaterThan(install);
    expect(job.indexOf("np-sync-templates")).toBeGreaterThan(install);
  });
});

describe("ci.yml lighthouse job", () => {
  const lighthouseJob = () => findJob("lighthouse");

  it("calls the reusable lighthouse workflow with this repo's config", () => {
    const job = lighthouseJob();
    expect(job).toMatch(
      /^\s+uses: neonpixels-studio\/packages\/\.github\/workflows\/lighthouse\.yml@[0-9a-f]{40} # \S/m,
    );
    expect(job).toMatch(/^\s+package-manager: npm\s*$/m);
    expect(job).toMatch(/^\s+config-path: \.\/\.lighthouserc\.json\s*$/m);
  });

  it("keeps its needs and grants contents: read and issues: write", () => {
    const job = lighthouseJob();
    expect(job).toMatch(/^\s+needs: \[ci, changes\]\s*$/m);
    expect(job).toMatch(/^\s+contents: read\s*$/m);
    expect(job).toMatch(/^\s+issues: write\s*$/m);
  });

  it("builds inside the reusable workflow instead of downloading the artifact", () => {
    expect(lighthouseJob()).not.toContain("download-artifact");
    expect(lighthouseJob()).toMatch(/^\s+build-script: build\s*$/m);
  });
});
