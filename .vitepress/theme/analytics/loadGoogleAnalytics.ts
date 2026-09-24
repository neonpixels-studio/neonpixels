// The one place this codebase talks to Google Analytics (gtag.js). Isolated
// here so the decision of *whether* to load it (analyticsConsent.ts) never
// has to know *how* GA4 is bootstrapped, and so a test can assert on the
// call without a real network request or a real gtag.js on the page.
//
// GA4 property for neonpixels.dev. gtag.js loads from googletagmanager.com
// and sends collection beacons to *.google-analytics.com — both are granted
// in the CSP (see netlify.toml script-src/img-src/connect-src). Unlike the
// rest of that CSP grant, this script tag is no longer declared statically
// in .vitepress/config.ts — see the exception documented in
// csp-head-crosscheck.test.ts.
export const GA_MEASUREMENT_ID = "G-Y4448RR4CR";

const GTAG_SCRIPT_URL = "https://www.googletagmanager.com/gtag/js";

// gtag.js's own contract: it expects `window.dataLayer` to already exist (or
// be created) before it starts draining commands pushed onto it. Not part of
// TypeScript's DOM lib, so it's declared here, once, for every caller.
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

// gtag.js's own bootstrap: seed `window.dataLayer` and push the two startup
// commands it expects to find waiting once the script itself loads and
// starts draining the queue. Mirrors Google's documented gtag.js snippet.
function queueGtagBootstrapCommands(
  dataLayer: unknown[],
  measurementId: string,
) {
  dataLayer.push(["js", new Date()]);
  dataLayer.push(["config", measurementId]);
}

function appendGtagScriptTag(target: AnalyticsTarget, measurementId: string) {
  const scriptElement = target.document.createElement("script");
  scriptElement.async = true;
  scriptElement.src = `${GTAG_SCRIPT_URL}?id=${measurementId}`;
  target.document.head.appendChild(scriptElement);
}

// Dynamically injects gtag.js and initializes it for the given measurement
// ID. Callers (ConsentBanner.vue) are responsible for only calling this once
// consent has actually been established — this function does no gating of
// its own.
export function loadGoogleAnalytics(
  measurementId: string,
  target: AnalyticsTarget = { document, window },
) {
  target.window.dataLayer = target.window.dataLayer ?? [];
  queueGtagBootstrapCommands(target.window.dataLayer, measurementId);
  appendGtagScriptTag(target, measurementId);
}
