import { describe, it, expect } from "vitest";
import {
  trackGoogleAnalyticsEvent,
  type AnalyticsEventTarget,
} from "@theme/analytics/loadGoogleAnalytics";

// gtag.js's queue processor is defined against the raw `arguments` object
// gtag.js's documented snippet pushes — not a plain array — so assert on that
// exact shape rather than a loose `toEqual` an array might pass on false
// grounds. `Array.from` reads it back as a plain array for the values check.
function expectQueuedGtagCommand(
  queuedEntry: unknown,
  expectedArgs: unknown[],
) {
  expect(Object.prototype.toString.call(queuedEntry)).toBe(
    "[object Arguments]",
  );
  expect(Array.from(queuedEntry as ArrayLike<unknown>)).toEqual(expectedArgs);
}

describe("trackGoogleAnalyticsEvent", () => {
  function createFakeEventTarget(): {
    target: AnalyticsEventTarget;
    fakeWindow: { dataLayer?: unknown[] };
  } {
    const fakeWindow: { dataLayer?: unknown[] } = {};
    return { target: { window: fakeWindow }, fakeWindow };
  }

  it("pushes an event command in the same arguments-object shape gtag.js's queue processor expects", () => {
    const { target, fakeWindow } = createFakeEventTarget();
    trackGoogleAnalyticsEvent(
      "outbound_click",
      { project_name: "grimicorn", destination_url: "https://grimicorn.dev" },
      target,
    );
    expectQueuedGtagCommand(fakeWindow.dataLayer?.[0], [
      "event",
      "outbound_click",
      { project_name: "grimicorn", destination_url: "https://grimicorn.dev" },
    ]);
  });

  it("creates dataLayer when the target has none yet", () => {
    const { target, fakeWindow } = createFakeEventTarget();
    expect(fakeWindow.dataLayer).toBeUndefined();
    trackGoogleAnalyticsEvent(
      "outbound_click",
      { project_name: "basin" },
      target,
    );
    expect(fakeWindow.dataLayer).toHaveLength(1);
  });

  it("appends to an existing dataLayer instead of replacing it", () => {
    const { target, fakeWindow } = createFakeEventTarget();
    const priorEntry = ["already queued"];
    fakeWindow.dataLayer = [priorEntry];
    trackGoogleAnalyticsEvent(
      "outbound_click",
      { project_name: "farflung" },
      target,
    );
    expect(fakeWindow.dataLayer?.[0]).toBe(priorEntry);
    expect(fakeWindow.dataLayer).toHaveLength(2);
  });

  // Every case above passes an explicit fake target; this one exercises the
  // `target: AnalyticsEventTarget = { window }` default instead, since that
  // default is the only path ProjectSummary.vue's production call (no third
  // argument) actually takes. Cleanup runs in `finally` (not just after the
  // assertions) so a failing assertion here can never leak a real
  // `window.dataLayer` into later tests in this file.
  it("defaults to the real global window when no target is given", () => {
    try {
      trackGoogleAnalyticsEvent("outbound_click", { project_name: "markpost" });
      expectQueuedGtagCommand(window.dataLayer?.[0], [
        "event",
        "outbound_click",
        { project_name: "markpost" },
      ]);
    } finally {
      delete (window as { dataLayer?: unknown[] }).dataLayer;
    }
  });
});
