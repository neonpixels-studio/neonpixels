// Loading, disabling, and cookie clean-up for gtag.js come from
// @neon-pixels/consent. What stays local is the measurement id and event
// tracking: the package defines no `window.gtag`, so events are pushed to
// `window.dataLayer` here.
export const GA_MEASUREMENT_ID = "G-Y4448RR4CR";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

// Queues one gtag.js command in the exact shape — the raw `arguments`
// object, NOT a plain array — gtag.js's own queue processor is defined
// against.
function pushGtagCommand(dataLayer: unknown[], ...args: unknown[]) {
  function gtag(..._args: unknown[]) {
    // Deliberately `arguments`, not `_args`: gtag.js's queue processor
    // requires the actual `arguments` object. `_args` exists only so
    // TypeScript accepts the rest-argument spread below.
    // eslint-disable-next-line prefer-rest-params -- gtag.js needs the real arguments object
    dataLayer.push(arguments);
  }
  gtag(...args);
}

// An event call only ever touches `window.dataLayer`, so a test can pass a
// plain object instead of the real global window.
export interface AnalyticsEventTarget {
  window: Pick<Window, "dataLayer">;
}

// Fires a GA4 event (e.g. the outbound-click CTAs in ProjectSummary.vue)
// through the same dataLayer queue gtag.js itself drains once loaded. Callers
// are responsible for the consent gate (see ProjectSummary.vue) — this
// function does no consent gating of its own. If GA
// hasn't loaded this session (consent never granted), the pushed entry just
// sits in an unread dataLayer array — never sent, since no gtag.js is present
// to drain it.
export function trackGoogleAnalyticsEvent(
  eventName: string,
  eventParams: Record<string, unknown>,
  target: AnalyticsEventTarget = { window },
) {
  target.window.dataLayer = target.window.dataLayer ?? [];
  pushGtagCommand(target.window.dataLayer, "event", eventName, eventParams);
}
