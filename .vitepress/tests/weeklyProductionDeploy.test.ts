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
const SECRET_REFERENCE = "secrets.NETLIFY_BUILD_HOOK_URL";
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

describe("weekly-production-deploy.yml", () => {
  it("runs on a Monday 14:00 UTC schedule", () => {
    expect(WORKFLOW).toMatch(/^\s+- cron: "0 14 \* \* 1"\s*$/m);
  });

  it("is also manually dispatchable", () => {
    expect(WORKFLOW).toMatch(/^\s+workflow_dispatch:/m);
  });

  it("grants only contents: read", () => {
    expect(WORKFLOW).toMatch(/^permissions:\n\s+contents:\s*read\n/m);
  });

  it("only deploys from main", () => {
    expect(WORKFLOW).toMatch(/^\s+if: github\.ref == 'refs\/heads\/main'\s*$/m);
  });

  it("passes the secret only via env, never inline in a run script", () => {
    const references = WORKFLOW.split("\n").filter((line) =>
      line.includes(SECRET_REFERENCE),
    );
    expect(references).toHaveLength(1);
    expect(references[0]).toMatch(
      /^\s+NETLIFY_BUILD_HOOK_URL: \$\{\{ secrets\.NETLIFY_BUILD_HOOK_URL \}\}\s*$/,
    );
  });

  it("fails when the secret is empty", () => {
    expect(WORKFLOW).toMatch(/if \[ -z "\$NETLIFY_BUILD_HOOK_URL" \]/);
  });

  it("calls the hook with failing curl and the documented titles", () => {
    expect(WORKFLOW).toContain(
      `curl --fail --silent --show-error -X POST -d '{}' "$NETLIFY_BUILD_HOOK_URL?trigger_title=$trigger_title"`,
    );
    expect(WORKFLOW).toContain("Weekly+production+deploy");
    expect(WORKFLOW).toContain("Manual+production+deploy");
  });

  it("checks full history for commits in the last 7 days on schedule only", () => {
    expect(WORKFLOW).toMatch(/fetch-depth: 0/);
    expect(WORKFLOW).toContain('--since="7 days ago"');
    expect(WORKFLOW).toContain('"$EVENT_NAME" != "schedule"');
  });

  it("declares a concurrency block", () => {
    expect(WORKFLOW).toMatch(/^concurrency:/m);
  });

  it("fails before firing the hook when the Netlify token is missing", () => {
    const tokenCheck = WORKFLOW.indexOf('if [ -z "$NETLIFY_AUTH_TOKEN" ]');
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(tokenCheck).toBeLessThan(
      WORKFLOW.indexOf("Trigger production deploy"),
    );
  });

  it("passes the token only via env from the secret", () => {
    const references = WORKFLOW.split("\n").filter((line) =>
      line.includes("secrets.NETLIFY_AUTH_TOKEN"),
    );
    expect(references).toEqual([
      "      NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}",
    ]);
  });

  it("verifies the deploy after triggering it", () => {
    expect(WORKFLOW.indexOf("verify-production-deploy.cjs")).toBeGreaterThan(
      WORKFLOW.indexOf("Trigger production deploy"),
    );
    expect(WORKFLOW).toContain(
      "NETLIFY_HOOK_RESPONSE: ${{ steps.trigger.outputs.hook_response }}",
    );
  });

  it("notifies on failure from a separate job that alone gets issues: write", () => {
    expect(WORKFLOW).toMatch(
      /notify-deploy-failure:\n\s+needs: deploy\n\s+if: failure\(\)/,
    );
    expect(WORKFLOW.match(/^\s+issues: write$/gm)).toHaveLength(1);
  });
});
