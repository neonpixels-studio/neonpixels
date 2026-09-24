import { describe, it, expect, vi } from "vitest";
import {
  disableGoogleAnalytics,
  loadGoogleAnalytics,
  type AnalyticsTarget,
} from "@theme/analytics/loadGoogleAnalytics";

const GTAG_SRC_PATTERN = /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=/;

// A fake AnalyticsTarget rather than the real DOM: proves loadGoogleAnalytics
// only ever seeds dataLayer and appends one <script>, without needing a real
// network request or leaving a real gtag.js tag behind in the test DOM. Cast
// through `unknown` at the boundary since the fake only implements the
// handful of members loadGoogleAnalytics actually calls, not every member of
// the real Document/Window types AnalyticsTarget's fields are drawn from.
// A fresh `fakeWindow` object per call also gives each test its own identity
// for loadGoogleAnalytics's per-window idempotency guard (a WeakSet keyed on
// `target.window`), so tests never see state bleed from one another.
function createFakeAnalyticsTarget() {
  const appendedScripts: { async: boolean; src: string }[] = [];
  const fakeDocument = {
    createElement: vi.fn(() => {
      const scriptElement = { async: false, src: "" };
      appendedScripts.push(scriptElement);
      return scriptElement;
    }),
    head: {
      appendChild: vi.fn(),
    },
  };
  const fakeWindow: { dataLayer?: unknown[] } = {};
  const target = {
    document: fakeDocument,
    window: fakeWindow,
  } as unknown as AnalyticsTarget;
  return { target, fakeDocument, fakeWindow, appendedScripts };
}

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

describe("loadGoogleAnalytics", () => {
  it("seeds dataLayer with the gtag.js bootstrap commands for the given measurement id", () => {
    const { target, fakeWindow } = createFakeAnalyticsTarget();
    loadGoogleAnalytics("G-TEST123", target);
    expectQueuedGtagCommand(fakeWindow.dataLayer?.[0], [
      "js",
      expect.any(Date),
    ]);
    expectQueuedGtagCommand(fakeWindow.dataLayer?.[1], ["config", "G-TEST123"]);
  });

  it("preserves an existing dataLayer instead of replacing it", () => {
    const { target, fakeWindow } = createFakeAnalyticsTarget();
    const priorEntry = ["already queued"];
    fakeWindow.dataLayer = [priorEntry];
    loadGoogleAnalytics("G-TEST123", target);
    expect(fakeWindow.dataLayer?.[0]).toBe(priorEntry);
    expect(fakeWindow.dataLayer).toHaveLength(3);
  });

  it("appends exactly one async gtag.js script tag scoped to the measurement id", () => {
    const { target, fakeDocument, appendedScripts } =
      createFakeAnalyticsTarget();
    loadGoogleAnalytics("G-TEST123", target);
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0].async).toBe(true);
    expect(appendedScripts[0].src).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST123",
    );
    expect(appendedScripts[0].src).toMatch(GTAG_SRC_PATTERN);
  });

  it("is idempotent per target window: a second call appends no second script and queues no second config", () => {
    const { target, fakeDocument, fakeWindow, appendedScripts } =
      createFakeAnalyticsTarget();
    loadGoogleAnalytics("G-TEST123", target);
    loadGoogleAnalytics("G-TEST123", target);
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    expect(appendedScripts).toHaveLength(1);
    expect(fakeWindow.dataLayer).toHaveLength(2);
  });

  it("still loads for a different target window even after another window was already initialized", () => {
    const first = createFakeAnalyticsTarget();
    const second = createFakeAnalyticsTarget();
    loadGoogleAnalytics("G-TEST123", first.target);
    loadGoogleAnalytics("G-TEST123", second.target);
    expect(first.appendedScripts).toHaveLength(1);
    expect(second.appendedScripts).toHaveLength(1);
  });
});

describe("disableGoogleAnalytics", () => {
  it("sets gtag.js's documented per-measurement-id kill switch on the given window", () => {
    const fakeWindow: Record<string, unknown> = {};
    disableGoogleAnalytics("G-TEST123", fakeWindow);
    expect(fakeWindow["ga-disable-G-TEST123"]).toBe(true);
  });

  it("scopes the kill switch to the exact measurement id, leaving others untouched", () => {
    const fakeWindow: Record<string, unknown> = {};
    disableGoogleAnalytics("G-TEST123", fakeWindow);
    expect(fakeWindow["ga-disable-G-OTHER456"]).toBeUndefined();
  });
});
