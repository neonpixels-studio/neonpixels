import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOWS_DIR = resolve(process.cwd(), ".github/workflows");
const JOBS_HEADER = /^jobs:\s*$/;
const JOB_LEVEL_LINE = /^ {2}[^\s#]/;
const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/;
const TIMEOUT_LINE =
  /^ {4}timeout-minutes:\s*([1-9]\d*|\$\{\{.+\}\})\s*(#.*)?$/;
const REUSABLE_CALL_LINE = /^ {4}uses:\s*\S/;
const TOP_LEVEL_KEY = /^[^\s#]/;

type Job = {
  name: string;
  hasTimeout: boolean;
  callsReusableWorkflow: boolean;
};

function parseJobs(content: string): Job[] {
  const jobs: Job[] = [];
  let inJobs = false;
  for (const line of content.split(/\r?\n/)) {
    if (JOBS_HEADER.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    if (TOP_LEVEL_KEY.test(line)) {
      inJobs = false;
      continue;
    }
    if (JOB_LEVEL_LINE.test(line)) {
      const jobMatch = JOB_KEY.exec(line);
      if (!jobMatch) {
        throw new Error(`Unrecognized job key: ${line.trim()}`);
      }
      jobs.push({
        name: jobMatch[1],
        hasTimeout: false,
        callsReusableWorkflow: false,
      });
      continue;
    }
    const current = jobs[jobs.length - 1];
    if (!current) {
      continue;
    }
    current.hasTimeout ||= TIMEOUT_LINE.test(line);
    current.callsReusableWorkflow ||= REUSABLE_CALL_LINE.test(line);
  }
  return jobs;
}

const WORKFLOW_FILES = readdirSync(WORKFLOWS_DIR).filter((file) =>
  /\.ya?ml$/.test(file),
);
const JOBS = WORKFLOW_FILES.flatMap((file) =>
  parseJobs(readFileSync(resolve(WORKFLOWS_DIR, file), "utf8")).map((job) => ({
    ...job,
    where: `${file}:${job.name}`,
  })),
);

describe("workflow job timeouts", () => {
  it.each(WORKFLOW_FILES)("finds jobs in %s", (file) => {
    const content = readFileSync(resolve(WORKFLOWS_DIR, file), "utf8");
    expect(parseJobs(content).length).toBeGreaterThan(0);
  });

  it("declares timeout-minutes on every job", () => {
    const missing = JOBS.filter(
      (job) => !job.hasTimeout && !job.callsReusableWorkflow,
    );
    expect(missing.map((job) => job.where)).toEqual([]);
  });

  it("omits timeout-minutes on reusable workflow calls", () => {
    const invalid = JOBS.filter(
      (job) => job.hasTimeout && job.callsReusableWorkflow,
    );
    expect(invalid.map((job) => job.where)).toEqual([]);
  });
});

describe("parseJobs", () => {
  const withJobs = (body: string) => `name: x\njobs:\n${body}\nenv:\n  A: 1\n`;

  it("flags a job without timeout-minutes", () => {
    const jobs = parseJobs(withJobs("  a:\n    runs-on: x\n"));
    expect(jobs).toEqual([
      { name: "a", hasTimeout: false, callsReusableWorkflow: false },
    ]);
  });

  it("does not credit a step-level timeout to the job", () => {
    const jobs = parseJobs(
      withJobs(
        "  a:\n    steps:\n      - run: x\n        timeout-minutes: 5\n",
      ),
    );
    expect(jobs[0].hasTimeout).toBe(false);
  });

  it("rejects timeout-minutes: 0", () => {
    const jobs = parseJobs(withJobs("  a:\n    timeout-minutes: 0\n"));
    expect(jobs[0].hasTimeout).toBe(false);
  });

  it("attributes timeouts to the right job across comments", () => {
    const jobs = parseJobs(
      withJobs(
        "  # note\n  a:\n    timeout-minutes: 5 # ok\n  b:\n    runs-on: x\n",
      ),
    );
    expect(jobs.map((job) => [job.name, job.hasTimeout])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("detects reusable workflow calls", () => {
    const jobs = parseJobs(withJobs("  a:\n    uses: ./.github/w.yml\n"));
    expect(jobs[0].callsReusableWorkflow).toBe(true);
  });

  it("throws on a job key it cannot parse", () => {
    expect(() => parseJobs(withJobs('  "a":\n    runs-on: x\n'))).toThrow(
      /Unrecognized job key/,
    );
  });
});
