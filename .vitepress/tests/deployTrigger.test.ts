import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import deployTrigger from "../../.github/scripts/deploy-trigger.cjs";

// deploy-trigger.cjs holds the commit-window and trigger-title steps of
// weekly-production-deploy.yml. The logic is driven with injected git and
// file writers, and the real CLI is executed against a throwaway repository.

const {
  isScheduled,
  checkRecentCommits,
  buildTriggerTitle,
  encodeTitle,
  prepareTrigger,
  main,
  escapeAnnotation,
  SCHEDULED_TITLE,
} = deployTrigger;

const SCRIPT_PATH = resolve(
  process.cwd(),
  ".github/scripts/deploy-trigger.cjs",
);
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN = { runId: "99", runAttempt: "2" };

describe("isScheduled", () => {
  it("is true only for the schedule event", () => {
    expect(isScheduled("schedule")).toBe(true);
    expect(isScheduled("workflow_dispatch")).toBe(false);
    expect(isScheduled(undefined)).toBe(false);
  });
});

describe("checkRecentCommits", () => {
  function run(eventName: string | undefined, commits: number) {
    const writeOutput = vi.fn();
    const countCommits = vi.fn(() => commits);
    const log = vi.fn();
    const skipped = checkRecentCommits({
      eventName,
      countCommits,
      writeOutput,
      log,
    });
    return { skipped, writeOutput, countCommits, log };
  }

  it("never skips a manual run and does not inspect history", () => {
    const { skipped, writeOutput, countCommits } = run("workflow_dispatch", 0);
    expect(skipped).toBe(false);
    expect(writeOutput).toHaveBeenCalledExactlyOnceWith("skip=false");
    expect(countCommits).not.toHaveBeenCalled();
  });

  it("skips a scheduled run with no commits in the window", () => {
    const { skipped, writeOutput, log } = run("schedule", 0);
    expect(skipped).toBe(true);
    expect(writeOutput).toHaveBeenCalledExactlyOnceWith("skip=true");
    expect(log).toHaveBeenCalledWith(
      "main has no commits in the last 7 days; skipping production deploy.",
    );
  });

  it("deploys a scheduled run with commits in the window", () => {
    const { skipped, writeOutput, log } = run("schedule", 3);
    expect(skipped).toBe(false);
    expect(writeOutput).toHaveBeenCalledExactlyOnceWith("skip=false");
    expect(log).toHaveBeenCalledWith(
      "main has 3 commit(s) in the last 7 days.",
    );
  });
});

describe("trigger title", () => {
  it("uses the weekly title for scheduled runs", () => {
    expect(buildTriggerTitle({ eventName: "schedule", ...RUN })).toBe(
      "Weekly production deploy run 99 attempt 2",
    );
  });

  it("uses the manual title for any other event", () => {
    expect(buildTriggerTitle({ eventName: "workflow_dispatch", ...RUN })).toBe(
      "Manual production deploy run 99 attempt 2",
    );
  });

  it("differs between attempts of the same run", () => {
    const first = buildTriggerTitle({ eventName: "schedule", ...RUN });
    const rerun = buildTriggerTitle({
      eventName: "schedule",
      runId: "99",
      runAttempt: "3",
    });
    expect(first).not.toBe(rerun);
  });

  it("replaces every space with a plus for the hook query string", () => {
    expect(encodeTitle("a b  c")).toBe("a+b++c");
  });

  it("writes the plain title to the env file and prints the encoded one", () => {
    const writeEnv = vi.fn();
    const print = vi.fn();
    const title = prepareTrigger({
      env: {
        EVENT_NAME: "schedule",
        GITHUB_RUN_ID: "99",
        GITHUB_RUN_ATTEMPT: "2",
      },
      writeEnv,
      print,
    });
    expect(title).toBe(`${SCHEDULED_TITLE} run 99 attempt 2`);
    expect(writeEnv).toHaveBeenCalledExactlyOnceWith(
      "NETLIFY_DEPLOY_TITLE=Weekly production deploy run 99 attempt 2",
    );
    expect(print).toHaveBeenCalledExactlyOnceWith(
      "Weekly+production+deploy+run+99+attempt+2",
    );
  });
});

describe("checkRecentCommits failure", () => {
  it("writes no output when the commit count cannot be read", () => {
    const writeOutput = vi.fn();
    expect(() =>
      checkRecentCommits({
        eventName: "schedule",
        countCommits: () => {
          throw new Error("git failed");
        },
        writeOutput,
      }),
    ).toThrow("git failed");
    expect(writeOutput).not.toHaveBeenCalled();
  });
});

describe("escapeAnnotation", () => {
  it("escapes percent signs and line breaks for workflow commands", () => {
    expect(escapeAnnotation("50% done\r\nnext")).toBe("50%25 done%0D%0Anext");
  });
});

describe("main", () => {
  it("requires the run id and attempt for the title", () => {
    expect(() =>
      main(["title"], { EVENT_NAME: "schedule", GITHUB_ENV: "/dev/null" }),
    ).toThrow("Missing required environment variable GITHUB_RUN_ID");
  });

  it("requires the output file for the recent check", () => {
    expect(() => main(["recent"], { EVENT_NAME: "schedule" })).toThrow(
      "Missing required environment variable GITHUB_OUTPUT",
    );
  });

  it("requires the event name for both commands", () => {
    expect(() => main(["recent"], { GITHUB_OUTPUT: "/dev/null" })).toThrow(
      "Missing required environment variable EVENT_NAME",
    );
    expect(() =>
      main(["title"], {
        GITHUB_ENV: "/dev/null",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      }),
    ).toThrow("Missing required environment variable EVENT_NAME");
  });

  it("rejects an unknown command", () => {
    expect(() => main(["bogus"], {})).toThrow(/Unknown command "bogus"/);
  });
});

describe("deploy-trigger.cjs executed", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeDirectory() {
    const directory = mkdtempSync(join(tmpdir(), "deploy-trigger-"));
    directories.push(directory);
    return directory;
  }

  function isolatedEnv(overrides: Record<string, string> = {}) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    return { ...inherited, ...overrides };
  }

  function git(directory: string, args: string[], env = {}) {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: isolatedEnv({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        ...env,
      }),
    });
    expect(result.status, result.stderr).toBe(0);
  }

  function makeRepoWithCommitAges(ageInDays: number[]) {
    const directory = makeDirectory();
    git(directory, ["init", "--quiet"]);
    for (const age of ageInDays) {
      const date = new Date(Date.now() - age * DAY_MS).toISOString();
      git(
        directory,
        ["commit", "--quiet", "--allow-empty", "-m", `commit ${age}d old`],
        { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      );
    }
    git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return directory;
  }

  function runScript(
    command: string,
    directory: string,
    env: Record<string, string>,
  ) {
    const outputFile = join(directory, "github-output");
    const envFile = join(directory, "github-env");
    writeFileSync(outputFile, "");
    writeFileSync(envFile, "");
    const result = spawnSync(process.execPath, [SCRIPT_PATH, command], {
      cwd: directory,
      encoding: "utf8",
      env: isolatedEnv({
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: envFile,
        ...env,
      }),
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(outputFile, "utf8"),
      envFile: readFileSync(envFile, "utf8"),
    };
  }

  it("skips a scheduled run when the newest commit is older than 7 days", () => {
    const directory = makeRepoWithCommitAges([30, 8]);
    const result = runScript("recent", directory, { EVENT_NAME: "schedule" });
    expect(result.status).toBe(0);
    expect(result.output).toBe("skip=true\n");
    expect(result.stdout).toContain("no commits in the last 7 days");
  });

  it("deploys a scheduled run when a commit is inside the window", () => {
    const directory = makeRepoWithCommitAges([30, 6]);
    const result = runScript("recent", directory, { EVENT_NAME: "schedule" });
    expect(result.status).toBe(0);
    expect(result.output).toBe("skip=false\n");
    expect(result.stdout).toContain("main has 1 commit(s)");
  });

  it("does not skip a manual run even with a stale history", () => {
    const directory = makeRepoWithCommitAges([30]);
    const result = runScript("recent", directory, {
      EVENT_NAME: "workflow_dispatch",
    });
    expect(result.status).toBe(0);
    expect(result.output).toBe("skip=false\n");
  });

  it("fails loudly when origin/main is missing", () => {
    const directory = makeDirectory();
    git(directory, ["init", "--quiet"]);
    const result = runScript("recent", directory, { EVENT_NAME: "schedule" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("::error::");
    const annotation = result.stderr
      .split("\n")
      .find((line) => line.startsWith("::error::"));
    expect(annotation).toContain("%0A");
    expect(result.output).toBe("");
  });

  it("prints the encoded title and exports the plain one", () => {
    const directory = makeDirectory();
    const result = runScript("title", directory, {
      EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Manual+production+deploy+run+123+attempt+1\n");
    expect(result.envFile).toBe(
      "NETLIFY_DEPLOY_TITLE=Manual production deploy run 123 attempt 1\n",
    );
  });

  it("exits non-zero with an error annotation for an unknown command", () => {
    const directory = makeDirectory();
    const result = runScript("bogus", directory, {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::Unknown command");
  });
});
