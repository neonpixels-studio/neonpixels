import { describe, it, expect, vi } from "vitest";

import verifyProductionDeploy from "../../.github/scripts/verify-production-deploy.cjs";
import type { NetlifyDeploy } from "../../.github/scripts/verify-production-deploy.cjs";

// verify-production-deploy.cjs is run by weekly-production-deploy.yml after
// the build hook fires. Network and clock are injected, so every outcome is
// driven here without Netlify or real waiting.

const {
  classifyDeployState,
  createNetlifyClient,
  pollDeployStatus,
  describeResult,
  NetlifyApiError,
  MAX_CONSECUTIVE_ERRORS,
  OUTCOME_SUCCESS,
  OUTCOME_FAILURE,
  OUTCOME_CANCELLED,
  OUTCOME_TIMEOUT,
} = verifyProductionDeploy;

const DEPLOY_BASE_TITLE = "Weekly production deploy run 99";
const DEPLOY_TITLE = "Weekly production deploy run 99 attempt 1";
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

function pollWith(
  fetchDeploy: (_title: string) => Promise<NetlifyDeploy | null>,
) {
  const clock = buildFakeClock();
  return {
    clock,
    result: pollDeployStatus({
      deployTitle: DEPLOY_TITLE,
      fetchDeploy,
      sleep: clock.sleep,
      now: clock.now,
      intervalMs: INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
    }),
  };
}

function poll(states: string[], overrides: Partial<NetlifyDeploy> = {}) {
  const queue = [...states];
  const fetchDeploy = vi.fn(async () => ({
    state: queue.length > 1 ? (queue.shift() as string) : queue[0],
    ...overrides,
  }));
  return { fetchDeploy, ...pollWith(fetchDeploy) };
}

describe("classifyDeployState", () => {
  it.each([
    ["ready", OUTCOME_SUCCESS],
    ["error", OUTCOME_FAILURE],
    ["rejected", OUTCOME_FAILURE],
    ["cancelled", OUTCOME_CANCELLED],
    ["canceled", OUTCOME_CANCELLED],
    ["skipped", OUTCOME_CANCELLED],
    ["building", "pending"],
    ["new", "pending"],
    ["enqueued", "pending"],
  ])("maps %s to %s", (state, outcome) => {
    expect(classifyDeployState(state)).toBe(outcome);
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

  it("retries a transient API error and still succeeds", async () => {
    const fetchDeploy = vi
      .fn()
      .mockRejectedValueOnce(new NetlifyApiError("/x", 503))
      .mockResolvedValue({ state: "ready" });
    const { result } = pollWith(fetchDeploy);
    expect(await result).toMatchObject({ outcome: OUTCOME_SUCCESS });
  });

  it("rethrows after consecutive API errors", async () => {
    const fetchDeploy = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = pollWith(fetchDeploy);
    await expect(result).rejects.toThrow("boom");
    expect(fetchDeploy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ERRORS);
  });

  it.each([401, 403, 404])("rethrows a %i immediately", async (status) => {
    const fetchDeploy = vi
      .fn()
      .mockRejectedValue(new NetlifyApiError("/x", status));
    const { result } = pollWith(fetchDeploy);
    await expect(result).rejects.toThrow(String(status));
    expect(fetchDeploy).toHaveBeenCalledTimes(1);
  });

  it("reports that no deploy was found when the title never appears", async () => {
    const { result } = pollWith(async () => null);
    expect(await result).toMatchObject({
      outcome: OUTCOME_TIMEOUT,
      state: "not found",
    });
  });
});

describe("createNetlifyClient", () => {
  function jsonResponse(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body };
  }

  it("finds the deploy by its unique title using the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        { title: "Some other deploy", state: "error" },
        { title: DEPLOY_TITLE, state: "ready" },
      ]),
    );
    const { fetchDeploy } = createNetlifyClient({
      token: "tok",
      siteId: "site/1",
      fetchImpl,
    });
    expect(await fetchDeploy(DEPLOY_TITLE)).toEqual({
      title: DEPLOY_TITLE,
      state: "ready",
    });
    expect(fetchImpl.mock.calls[0][0]).toContain("/sites/site%2F1/deploys");
    expect(fetchImpl.mock.calls[0][0]).toContain("production=true");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("ignores a terminal deploy from a previous attempt of the same run", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([
          { title: `${DEPLOY_BASE_TITLE} attempt 1`, state: "error" },
        ]),
      );
    const { fetchDeploy } = createNetlifyClient({
      token: "tok",
      siteId: "s",
      fetchImpl,
    });
    expect(await fetchDeploy(`${DEPLOY_BASE_TITLE} attempt 2`)).toBeNull();
  });

  it("reports pending while the deploy is not listed yet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const { fetchDeploy } = createNetlifyClient({
      token: "tok",
      siteId: "s",
      fetchImpl,
    });
    expect(await fetchDeploy(DEPLOY_TITLE)).toBeNull();
  });

  it("throws a NetlifyApiError on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const { fetchDeploy } = createNetlifyClient({
      token: "bad",
      siteId: "s",
      fetchImpl,
    });
    await expect(fetchDeploy(DEPLOY_TITLE)).rejects.toBeInstanceOf(
      NetlifyApiError,
    );
  });
});

describe("escapeWorkflowCommand", () => {
  it("escapes characters that could end or inject a workflow command", () => {
    expect(
      verifyProductionDeploy.escapeWorkflowCommand("50%\r\n::error::x"),
    ).toBe("50%25%0D%0A::error::x");
  });
});

describe("describeResult", () => {
  it("collapses multi-line Netlify error messages", () => {
    expect(
      describeResult({
        outcome: OUTCOME_FAILURE,
        state: "error",
        deploy: { state: "error", error_message: "a\n::error::b" },
      }),
    ).not.toContain("\n");
  });

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
    NETLIFY_SITE_ID: "site",
    NETLIFY_DEPLOY_TITLE: DEPLOY_TITLE,
  };

  function stubFetch(state: string) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ title: DEPLOY_TITLE, state }],
    }));
  }

  function verify(state: string, extra = {}) {
    const clock = buildFakeClock();
    return verifyProductionDeploy({
      env,
      fetchImpl: stubFetch(state),
      sleep: clock.sleep,
      now: clock.now,
      log: vi.fn(),
      intervalMs: INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      ...extra,
    });
  }

  it("resolves when the deploy is ready", async () => {
    expect((await verify("ready")).outcome).toBe(OUTCOME_SUCCESS);
  });

  it("rejects when the deploy errors", async () => {
    await expect(verify("error")).rejects.toThrow(/failure/);
  });

  it("rejects when the deploy is cancelled", async () => {
    await expect(verify("cancelled")).rejects.toThrow(/cancelled/);
  });

  it("rejects on timeout", async () => {
    await expect(verify("building")).rejects.toThrow(/timeout/);
  });

  it.each(["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID", "NETLIFY_DEPLOY_TITLE"])(
    "fails with a clear message when %s is missing",
    async (name) => {
      await expect(
        verify("ready", { env: { ...env, [name]: undefined } }),
      ).rejects.toThrow(`${name} is not set`);
    },
  );
});
