import { describe, it, expect, vi } from "vitest";
import {
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

describe("loadGoogleAnalytics", () => {
  it("seeds dataLayer with the gtag.js bootstrap commands for the given measurement id", () => {
    const { target, fakeWindow } = createFakeAnalyticsTarget();
    loadGoogleAnalytics("G-TEST123", target);
    expect(fakeWindow.dataLayer?.[0]).toEqual(["js", expect.any(Date)]);
    expect(fakeWindow.dataLayer?.[1]).toEqual(["config", "G-TEST123"]);
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
});
