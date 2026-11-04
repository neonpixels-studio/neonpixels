import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { PROJECTS } from "@theme/data/projects";

import {
  checkAll,
  checkTarget,
  extractDashboardTarget,
  extractProjectTargets,
  isAliveStatus,
  loadTargets,
  run,
  type FetchLike,
} from "../../health/checkProjectUrls";

const NO_DELAY = 0;
const TARGET = { label: "project", url: "https://example.test" };

function respondWith(...statuses: number[]) {
  const queue = [...statuses];
  return vi.fn<FetchLike>(async () => ({ status: queue.shift() ?? 500 }));
}

describe("target extraction (no second copy of the URL list)", () => {
  it("finds exactly the PROJECTS urls, in order", () => {
    const source = readFileSync(
      resolve(process.cwd(), ".vitepress/theme/data/projects.ts"),
      "utf8",
    );
    expect(extractProjectTargets(source).map((target) => target.url)).toEqual(
      PROJECTS.map((project) => project.url),
    );
  });

  it("reads the /dashboard redirect target from netlify.toml", () => {
    const toml = readFileSync(resolve(process.cwd(), "netlify.toml"), "utf8");
    expect(extractDashboardTarget(toml).url).toBe(
      "https://dashboard.neonpixels.dev",
    );
  });

  it("does not pick up the /dashboard/* splat rule", () => {
    const toml = `[[redirects]]\n  from = "/dashboard/*"\n  to = "https://other.test/:splat"\n`;
    expect(() => extractDashboardTarget(toml)).toThrow(/No \/dashboard/);
  });

  it("loads the four projects plus the dashboard target", () => {
    const urls = loadTargets(process.cwd()).map((target) => target.url);
    expect(urls).toHaveLength(PROJECTS.length + 1);
    expect(urls).toContain("https://dashboard.neonpixels.dev");
  });
});

describe("isAliveStatus", () => {
  it.each([200, 204, 301, 302, 399])("treats %i as alive", (status) => {
    expect(isAliveStatus(status)).toBe(true);
  });

  it.each([199, 400, 404, 500, 503])("treats %i as down", (status) => {
    expect(isAliveStatus(status)).toBe(false);
  });
});

describe("checkTarget", () => {
  it("passes on the first 2xx without retrying", async () => {
    const fetchImpl = respondWith(200);
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends HEAD without following redirects, so a 301 counts as alive", async () => {
    const fetchImpl = respondWith(301);
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "HEAD",
      redirect: "manual",
    });
  });

  it("retries once and passes when the second attempt succeeds", async () => {
    const fetchImpl = respondWith(503, 200);
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails after exactly two attempts on a persistent 5xx", async () => {
    const fetchImpl = respondWith(503, 503, 200);
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result).toMatchObject({ ok: false, detail: "HTTP 503" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown network error as down and reports the cause code", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValue(
        new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
      );
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOTFOUND");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 405 on HEAD as GET and uses that status", async () => {
    const fetchImpl = respondWith(405, 200);
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual([
      "HEAD",
      "GET",
    ]);
  });

  it("also falls back to GET on a 501 HEAD response", async () => {
    const fetchImpl = respondWith(501, 200);
    await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(fetchImpl.mock.calls[1][1].method).toBe("GET");
  });

  it("does not fall back to GET when HEAD throws", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error("boom"));
    await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual([
      "HEAD",
      "HEAD",
    ]);
  });

  it("cancels the response body so the GET fallback does not leak a socket", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn<FetchLike>(async () => ({
      status: 200,
      body: { cancel },
    }));
    await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(cancel).toHaveBeenCalled();
  });

  it("passes a timeout signal to every request", async () => {
    const fetchImpl = respondWith(200);
    await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("checkAll", () => {
  it("reports each target independently so one outage is not masked", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => ({
      status: url.includes("down") ? 500 : 200,
    }));
    const results = await checkAll(
      [
        { label: "a", url: "https://up.test" },
        { label: "b", url: "https://down.test" },
      ],
      fetchImpl,
      NO_DELAY,
    );
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });
});

describe("run (exit code gate)", () => {
  const summaryDir = mkdtempSync(join(tmpdir(), "project-url-check-"));
  afterAll(() => rmSync(summaryDir, { recursive: true, force: true }));

  function runWith(status: (_target: string) => number, summaryName: string) {
    const summaryPath = join(summaryDir, summaryName);
    const fetchImpl = vi.fn<FetchLike>(async (url) => ({
      status: status(url),
    }));
    const silence = vi.spyOn(console, "log").mockImplementation(() => {});
    const silenceError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    return run({
      root: process.cwd(),
      fetchImpl,
      summaryPath,
      retryDelayMs: NO_DELAY,
    }).finally(() => {
      silence.mockRestore();
      silenceError.mockRestore();
    });
  }

  it("returns 0 when every target is alive", async () => {
    expect(await runWith(() => 200, "ok.md")).toBe(0);
  });

  it("returns 1 and writes a FAIL summary line when one target is down", async () => {
    const exitCode = await runWith(
      (url) => (url.includes("basin.fm") ? 503 : 200),
      "down.md",
    );
    expect(exitCode).toBe(1);
    const summary = readFileSync(join(summaryDir, "down.md"), "utf8");
    expect(summary).toMatch(/FAIL .*basin\.fm.*HTTP 503/);
  });
});
