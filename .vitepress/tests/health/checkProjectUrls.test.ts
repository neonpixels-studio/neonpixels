import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECTS } from "@theme/data/projects";

import {
  checkAll,
  checkTarget,
  extractDashboardTarget,
  extractProjectTargets,
  isAliveStatus,
  loadTargets,
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

  it("treats a thrown network error as down and reports the reason", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error("ENOTFOUND"));
    const result = await checkTarget(TARGET, fetchImpl, NO_DELAY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOTFOUND");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
