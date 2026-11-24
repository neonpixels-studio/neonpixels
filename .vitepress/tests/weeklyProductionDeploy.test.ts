import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NETLIFY_CONFIG = readFileSync(
  resolve(process.cwd(), "netlify.toml"),
  "utf8",
);
const WORKFLOW = readFileSync(
  resolve(process.cwd(), ".github/workflows/weekly-production-deploy.yml"),
  "utf8",
);

const HOOK_TITLE_ENV = "INCOMING_HOOK_TITLE";
const SECRET_NAMES = [
  "NETLIFY_BUILD_HOOK_URL",
  "NETLIFY_AUTH_TOKEN",
  "NETLIFY_SITE_ID",
];
const PRODUCTION_HEADER = /^\[context\.production\]\s*$/m;

// Slices the [context.production] table up to the next table header.
function readProductionTable() {
  const lines = NETLIFY_CONFIG.split("\n");
  const start = lines.findIndex(
    (line) => line.trim() === "[context.production]",
  );
  if (start === -1) {
    throw new Error("netlify.toml has no [context.production] table");
  }
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.trim().startsWith("["));
  return rest.slice(0, next === -1 ? rest.length : next).join("\n");
}

function readIgnoreCommand() {
  const match = readProductionTable().match(
    /^\s*ignore\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m,
  );
  if (!match) {
    throw new Error("[context.production] has no ignore command");
  }
  return JSON.parse(match[1]) as string;
}

function runIgnore(env: Record<string, string>) {
  const cleanEnv = { ...process.env };
  delete cleanEnv[HOOK_TITLE_ENV];
  return spawnSync("sh", ["-c", readIgnoreCommand()], {
    env: { ...cleanEnv, ...env },
  }).status;
}

describe("netlify.toml production ignore gate", () => {
  it("builds (exit 1) when triggered by a build hook", () => {
    expect(runIgnore({ [HOOK_TITLE_ENV]: "Weekly production deploy" })).toBe(1);
  });

  it("cancels the build (exit 0) when not triggered by a hook", () => {
    expect(runIgnore({})).toBe(0);
  });

  it("cancels the build (exit 0) when the hook title is empty", () => {
    expect(runIgnore({ [HOOK_TITLE_ENV]: "" })).toBe(0);
  });

  it("has no build-level ignore that could skip deploy previews", () => {
    const beforeProduction = NETLIFY_CONFIG.split(PRODUCTION_HEADER)[0];
    expect(beforeProduction).not.toMatch(/^\s*ignore\s*=/m);
  });

  it("declares [context.production] exactly once", () => {
    expect(NETLIFY_CONFIG.match(/^\[context\.production\]/gm)).toHaveLength(1);
  });
});

function readJob(name: string) {
  const pattern = new RegExp(
    `^ {2}${name}:[\\s\\S]*?(?=^ {2}\\S|(?![\\s\\S]))`,
    "m",
  );
  const job = pattern.exec(WORKFLOW)?.[0];
  if (!job) {
    throw new Error(`weekly-production-deploy.yml has no ${name} job`);
  }
  return job;
}

const readE2eJob = () => readJob("e2e");
const REUSABLE_DEPLOY =
  /^\s+uses: neonpixels-studio\/packages\/\.github\/workflows\/production-deploy\.yml@[0-9a-f]{40} # \S.*$/m;

describe("weekly-production-deploy.yml", () => {
  it("runs on a Monday 14:00 UTC schedule", () => {
    expect(WORKFLOW).toMatch(/^\s+- cron: "0 14 \* \* 1"\s*$/m);
  });

  it("is also manually dispatchable", () => {
    expect(WORKFLOW).toMatch(/^\s+workflow_dispatch:/m);
  });

  it("grants only contents: read at the workflow level", () => {
    expect(WORKFLOW).toMatch(/^permissions:\n\s+contents:\s*read\n/m);
  });

  it("gates the deploy on a passing e2e job that builds and runs Playwright", () => {
    const e2eJob = readE2eJob();
    expect(e2eJob).toContain("run: npm run build");
    expect(e2eJob).toMatch(/run: npm run e2e\s*$/m);
    expect(e2eJob).toContain("if: github.ref == 'refs/heads/main'");
    expect(readJob("deploy")).toMatch(/^\s+needs: e2e\s*$/m);
  });

  it("keeps Netlify secrets out of the e2e job", () => {
    expect(readE2eJob()).not.toContain("secrets.");
  });

  it("calls the reusable production deploy pinned to a commit SHA", () => {
    expect(readJob("deploy")).toMatch(REUSABLE_DEPLOY);
  });

  it("no longer runs the local recent-commits check or deploy scripts", () => {
    expect(WORKFLOW).not.toMatch(/^ {2}recent:/m);
    expect(WORKFLOW).not.toContain(".github/scripts/");
    expect(WORKFLOW).not.toContain("curl");
  });

  it("grants the deploy job exactly the permissions the reusable workflow needs", () => {
    const permissions = readJob("deploy")
      .split("permissions:")[1]
      .split(/\n {4}\S/)[0];
    expect(permissions).toMatch(/^\s+contents: read$/m);
    expect(permissions).toMatch(/^\s+actions: read$/m);
    expect(permissions).toMatch(/^\s+issues: write$/m);
    expect(permissions.match(/^\s+\S+:/gm)).toHaveLength(3);
  });

  it("grants issues: write to the deploy call only", () => {
    expect(WORKFLOW.match(/^\s+issues: write$/gm)).toHaveLength(1);
  });

  it("passes the three Netlify secrets by name, never with secrets: inherit", () => {
    const deployJob = readJob("deploy");
    expect(deployJob).not.toContain("inherit");
    for (const name of SECRET_NAMES) {
      expect(deployJob).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(WORKFLOW.match(/secrets\.NETLIFY_\w+/g)).toHaveLength(
      SECRET_NAMES.length,
    );
  });

  it("declares a non-cancelling concurrency group the reusable workflow does not reserve", () => {
    expect(WORKFLOW).toMatch(
      /^concurrency:\n\s+group: \$\{\{ github\.workflow \}\}\n\s+cancel-in-progress: false\n/m,
    );
    expect(WORKFLOW).not.toMatch(
      /^\s+group:.*(np-production-deploy|np-deploy-failure-issue)/m,
    );
  });
});
