import { describe, it, expect, vi } from "vitest";

import verifyProductionDeploy from "../../.github/scripts/verify-production-deploy.cjs";
import type { NetlifyDeploy } from "../../.github/scripts/verify-production-deploy.cjs";

// verify-production-deploy.cjs is run by weekly-production-deploy.yml after
// the build hook fires. Network and clock are injected, so every outcome is
// driven here without Netlify or real waiting.

const {
  classifyDeployState,
  parseBuildId,
  createNetlifyClient,
  pollDeployStatus,
  describeResult,
  OUTCOME_SUCCESS,
  OUTCOME_FAILURE,
  OUTCOME_CANCELLED,
  OUTCOME_TIMEOUT,
} = verifyProductionDeploy;

const BUILD_ID = "build-123";
const INTERVAL_MS = 1000;
const TIMEOUT_MS = 5000;

function buildFakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds: number) => {
      current += milliseconds;
    }),
  };
}

function poll(states: string[], overrides: Partial<NetlifyDeploy> = {}) {
  const clock = buildFakeClock();
  const queue = [...states];
  const fetchDeploy = vi.fn(async () => ({
    state: queue.length > 1 ? (queue.shift() as string) : queue[0],
    ...overrides,
  }));
  return {
    fetchDeploy,
    clock,
    result: pollDeployStatus({
      buildId: BUILD_ID,
      fetchDeploy,
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
    }),
  };
}

describe("classifyDeployState", () => {
  it.each([
    ["ready", OUTCOME_SUCCESS],
    ["error", OUTCOME_FAILURE],
    ["rejected", OUTCOME_FAILURE],
    ["cancelled", OUTCOME_CANCELLED],
    ["skipped", OUTCOME_CANCELLED],
    ["building", "pending"],
    ["new", "pending"],
    ["enqueued", "pending"],
  ])("maps %s to %s", (state, outcome) => {
    expect(classifyDeployState(state)).toBe(outcome);
  });
});

describe("parseBuildId", () => {
  it("returns the id from the hook response", () => {
    expect(parseBuildId(JSON.stringify({ id: BUILD_ID }))).toBe(BUILD_ID);
  });

  it("rejects non-JSON bodies", () => {
    expect(() => parseBuildId("<html>")).toThrow(/not JSON/);
  });

  it("rejects a response without an id", () => {
    expect(() => parseBuildId("{}")).toThrow(/build id/);
  });
});

describe("pollDeployStatus", () => {
  it("returns success once the deploy is ready", async () => {
    const { result, clock } = poll(["building", "ready"]);
    expect(await result).toMatchObject({
      outcome: OUTCOME_SUCCESS,
      state: "ready",
    });
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  it("returns failure when the build errors", async () => {
    const { result } = poll(["building", "error"], {
      error_message: "Tests failed",
    });
    expect(await result).toMatchObject({
      outcome: OUTCOME_FAILURE,
      state: "error",
    });
  });

  it("returns cancelled when the deploy is cancelled", async () => {
    const { result } = poll(["cancelled"]);
    expect(await result).toMatchObject({ outcome: OUTCOME_CANCELLED });
  });

  it("times out when the deploy never finishes", async () => {
    const { result, fetchDeploy } = poll(["building"]);
    expect(await result).toMatchObject({
      outcome: OUTCOME_TIMEOUT,
      state: "building",
    });
    expect(fetchDeploy).toHaveBeenCalledTimes(TIMEOUT_MS / INTERVAL_MS);
  });

  it("propagates API errors instead of swallowing them", async () => {
    const clock = buildFakeClock();
    await expect(
      pollDeployStatus({
        buildId: BUILD_ID,
        fetchDeploy: async () => {
          throw new Error("boom");
        },
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow("boom");
  });
});

describe("createNetlifyClient", () => {
  function jsonResponse(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body };
  }

  it("follows the build to its deploy using the bearer token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ deploy_id: "deploy-9" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ready" }));
    const { fetchDeploy } = createNetlifyClient({ token: "tok", fetchImpl });
    expect(await fetchDeploy(BUILD_ID)).toEqual({ state: "ready" });
    expect(fetchImpl.mock.calls[0][0]).toContain(`/builds/${BUILD_ID}`);
    expect(fetchImpl.mock.calls[1][0]).toContain("/deploys/deploy-9");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("reports a pending deploy while the build has no deploy id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const { fetchDeploy } = createNetlifyClient({ token: "tok", fetchImpl });
    expect(await fetchDeploy(BUILD_ID)).toEqual({ state: "new" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-OK API response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const { fetchDeploy } = createNetlifyClient({ token: "bad", fetchImpl });
    await expect(fetchDeploy(BUILD_ID)).rejects.toThrow(/401/);
  });
});

describe("describeResult", () => {
  it("includes the Netlify error message on failure", () => {
    expect(
      describeResult({
        outcome: OUTCOME_FAILURE,
        state: "error",
        deploy: { state: "error", error_message: "Tests failed" },
      }),
    ).toContain("Tests failed");
  });
});

describe("verifyProductionDeploy", () => {
  const env = {
    NETLIFY_AUTH_TOKEN: "tok",
    NETLIFY_HOOK_RESPONSE: JSON.stringify({ id: BUILD_ID }),
  };

  function stubFetch(state: string) {
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/builds/") ? { deploy_id: "d1" } : { state },
    }));
  }

  it("resolves when the deploy is ready", async () => {
    const clock = buildFakeClock();
    const result = await verifyProductionDeploy({
      env,
      fetchImpl: stubFetch("ready"),
      sleep: clock.sleep,
      now: clock.now,
      log: vi.fn(),
    });
    expect(result.outcome).toBe(OUTCOME_SUCCESS);
  });

  it("rejects when the deploy errors", async () => {
    const clock = buildFakeClock();
    await expect(
      verifyProductionDeploy({
        env,
        fetchImpl: stubFetch("error"),
        sleep: clock.sleep,
        now: clock.now,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/failure/);
  });

  it("rejects on timeout", async () => {
    const clock = buildFakeClock();
    await expect(
      verifyProductionDeploy({
        env,
        fetchImpl: stubFetch("building"),
        sleep: clock.sleep,
        now: clock.now,
        log: vi.fn(),
        intervalMs: INTERVAL_MS,
        timeoutMs: TIMEOUT_MS,
      }),
    ).rejects.toThrow(/timeout/);
  });

  it("fails with a clear message when the token is missing", async () => {
    await expect(
      verifyProductionDeploy({
        env: { NETLIFY_HOOK_RESPONSE: env.NETLIFY_HOOK_RESPONSE },
        log: vi.fn(),
      }),
    ).rejects.toThrow(/NETLIFY_AUTH_TOKEN is not set/);
  });
});
