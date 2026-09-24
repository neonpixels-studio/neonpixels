// The one place this codebase talks to Google Analytics (gtag.js). Isolated
// so the decision of *whether* to load it (analyticsConsent.ts) never has to
// know *how* GA4 is bootstrapped, and so a test can assert on the call
// without a real network request or a real gtag.js on the page.
export const GA_MEASUREMENT_ID = "G-Y4448RR4CR";

// Exported so csp-head-crosscheck.test.ts can derive its documented CSP
// exception from this value instead of a second, independently-drifting copy.
export const GTAG_SCRIPT_URL = "https://www.googletagmanager.com/gtag/js";

declare global {
  // Base ESLint (no type-aware TS plugin is configured here) doesn't
  // understand declare-global interface merging and reads this as an unused
  // local declaration of `Window` — same false positive already documented
  // for .github/scripts/notify-audit-failure.d.cts in eslint.config.js.
  // eslint-disable-next-line no-unused-vars
  interface Window {
    dataLayer?: unknown[];
  }
}

// The narrow slice of `Window`/`Document` this module touches, so a test can
// pass an in-memory fake instead of asserting against the real global
// `document`/`window` (and the real DOM they'd otherwise leave mutated).
export interface AnalyticsTarget {
  document: Pick<Document, "createElement"> & {
    head: Pick<HTMLHeadElement, "appendChild">;
  };
  window: Pick<Window, "dataLayer">;
}

// gtag.js's documented bootstrap snippet, translated 1:1: define a `gtag`
// function that queues its raw `arguments` object — NOT a plain array, since
// gtag.js's own queue processor (loaded moments later, once the script tag
// below resolves) is defined against that exact shape — then call it for the
// two startup commands gtag.js expects to find waiting when it starts
// draining the queue.
function queueGtagBootstrapCommands(
  dataLayer: unknown[],
  measurementId: string,
) {
  function gtag(..._args: unknown[]) {
    // Deliberately `arguments`, not `_args`: gtag.js's queue processor
    // requires the actual `arguments` object. `_args` exists only so
    // TypeScript checks call-site arity for the two calls below.
    dataLayer.push(arguments);
  }
  gtag("js", new Date());
  gtag("config", measurementId);
}

function appendGtagScriptTag(target: AnalyticsTarget, measurementId: string) {
  const scriptElement = target.document.createElement("script");
  scriptElement.async = true;
  scriptElement.src = `${GTAG_SCRIPT_URL}?id=${measurementId}`;
  target.document.head.appendChild(scriptElement);
}

// Tracked per target `window` (a WeakSet, not a module-level boolean) so
// distinct fake targets in different tests never share state, while a real
// page still only ever gets one script tag/one "config" call even if a
// caller (or a future dev-mode HMR remount of ConsentBanner.vue) invokes this
// twice — GA4 would otherwise count that as duplicate pageviews.
const initializedAnalyticsWindows = new WeakSet<object>();

// Dynamically injects gtag.js and initializes it for the given measurement
// ID. Callers (ConsentBanner.vue) are responsible for only calling this once
// consent has actually been established — this function does no consent
// gating of its own, only load-once gating.
export function loadGoogleAnalytics(
  measurementId: string,
  target: AnalyticsTarget = { document, window },
) {
  if (initializedAnalyticsWindows.has(target.window)) {
    return;
  }
  initializedAnalyticsWindows.add(target.window);
  target.window.dataLayer = target.window.dataLayer ?? [];
  queueGtagBootstrapCommands(target.window.dataLayer, measurementId);
  appendGtagScriptTag(target, measurementId);
}
