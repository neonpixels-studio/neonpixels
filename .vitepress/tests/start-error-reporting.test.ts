import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { App } from "vue";

import { SENTRY_DSN } from "../sentry-dsn";

const initErrorReporting = vi.hoisted(() => vi.fn());

vi.mock("@theme/error-reporting", () => ({ initErrorReporting }));

import { startErrorReporting } from "@theme/start-error-reporting";

const ENVIRONMENT = "preview";
const app = {} as App;

function setReadyState(state: DocumentReadyState) {
  vi.spyOn(document, "readyState", "get").mockReturnValue(state);
}

async function flushDynamicImport() {
  await vi.dynamicImportSettled();
}

beforeEach(() => {
  initErrorReporting.mockReset();
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => callback());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("startErrorReporting", () => {
  it("does not load the SDK until the page has loaded", async () => {
    setReadyState("loading");
    startErrorReporting(app, ENVIRONMENT);
    await flushDynamicImport();
    expect(initErrorReporting).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    await flushDynamicImport();
    expect(initErrorReporting).toHaveBeenCalledOnce();
  });

  it("starts with the app, the DSN, the build environment and the page origin", async () => {
    setReadyState("complete");
    startErrorReporting(app, ENVIRONMENT);
    await flushDynamicImport();
    expect(initErrorReporting).toHaveBeenCalledWith(app, {
      dsn: SENTRY_DSN,
      environment: ENVIRONMENT,
      origin: window.location.origin,
    });
  });

  it("waits for the browser to be idle", async () => {
    setReadyState("complete");
    let runIdle = () => {};
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      runIdle = callback;
    });
    startErrorReporting(app, ENVIRONMENT);
    await flushDynamicImport();
    expect(initErrorReporting).not.toHaveBeenCalled();

    runIdle();
    await flushDynamicImport();
    expect(initErrorReporting).toHaveBeenCalledOnce();
  });

  it("falls back to a timeout where requestIdleCallback is missing", async () => {
    vi.useFakeTimers();
    setReadyState("complete");
    vi.stubGlobal("requestIdleCallback", undefined);
    startErrorReporting(app, ENVIRONMENT);
    expect(initErrorReporting).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await flushDynamicImport();
    expect(initErrorReporting).toHaveBeenCalledOnce();
  });

  it("never throws when the SDK fails to start", async () => {
    setReadyState("complete");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    initErrorReporting.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => startErrorReporting(app, ENVIRONMENT)).not.toThrow();
    await flushDynamicImport();
    expect(consoleError).toHaveBeenCalledWith(
      "Error reporting failed to start",
      expect.any(Error),
    );
  });
});
