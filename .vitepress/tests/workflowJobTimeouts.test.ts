import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOWS_DIR = resolve(process.cwd(), ".github/workflows");
const JOBS_HEADER = /^jobs:\s*$/;
const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/;
const TIMEOUT_LINE =
  /^ {4}timeout-minutes:\s*([1-9]\d*|\$\{\{.+\}\})\s*(#.*)?$/;
// GitHub rejects timeout-minutes on jobs that call a reusable workflow.
const REUSABLE_CALL_LINE = /^ {4}uses:\s*\S/;
const TOP_LEVEL_KEY = /^\S/;

type JobTimeout = {
  where: string;
  hasTimeout: boolean;
  callsReusableWorkflow: boolean;
};

function parseJobs(file: string): JobTimeout[] {
  const jobs: JobTimeout[] = [];
  let inJobs = false;
  readFileSync(resolve(WORKFLOWS_DIR, file), "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      if (JOBS_HEADER.test(line)) {
        inJobs = true;
        return;
      }
      if (inJobs && TOP_LEVEL_KEY.test(line) && !line.startsWith("#")) {
        inJobs = false;
        return;
      }
      const jobMatch = inJobs ? JOB_KEY.exec(line) : null;
      if (jobMatch) {
        jobs.push({
          where: `${file}:${jobMatch[1]}`,
          hasTimeout: false,
          callsReusableWorkflow: false,
        });
        return;
      }
      if (!inJobs || jobs.length === 0) {
        return;
      }
      const current = jobs[jobs.length - 1];
      current.hasTimeout ||= TIMEOUT_LINE.test(line);
      current.callsReusableWorkflow ||= REUSABLE_CALL_LINE.test(line);
    });
  return jobs;
}

const WORKFLOW_FILES = readdirSync(WORKFLOWS_DIR).filter((file) =>
  /\.ya?ml$/.test(file),
);
const JOBS = WORKFLOW_FILES.flatMap(parseJobs);

describe("workflow job timeouts", () => {
  it("finds jobs to check", () => {
    expect(JOBS.length).toBeGreaterThan(0);
  });

  it.each(WORKFLOW_FILES)("finds jobs in %s", (file) => {
    expect(parseJobs(file).length).toBeGreaterThan(0);
  });

  it("declares timeout-minutes on every job", () => {
    const missing = JOBS.filter(
      (job) => !job.hasTimeout && !job.callsReusableWorkflow,
    );
    expect(missing.map((job) => job.where)).toEqual([]);
  });
});
