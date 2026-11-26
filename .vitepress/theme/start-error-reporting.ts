import type { App } from "vue";
import { SENTRY_DSN } from "../sentry-dsn";

const IDLE_TIMEOUT_MS = 5000;
const FALLBACK_DELAY_MS = 1;

function whenPageLoaded(callback: () => void) {
  if (document.readyState === "complete") {
    callback();
    return;
  }
  window.addEventListener("load", callback, { once: true });
}

function whenIdle(callback: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    return;
  }
  window.setTimeout(callback, FALLBACK_DELAY_MS);
}

// Failing to fetch or start the SDK (blocked chunk, ad blocker, bad init) must
// leave the page working, only unreported.
async function loadAndInit(app: App, environment: string) {
  try {
    const { initErrorReporting } = await import("./error-reporting");
    initErrorReporting(app, {
      dsn: SENTRY_DSN,
      environment,
      origin: window.location.origin,
    });
  } catch (error) {
    console.error("Error reporting failed to start", error);
  }
}

// Starts Sentry after the page has loaded and the browser is idle, so the SDK
// chunk is never part of the entry bundle or the load path.
export function startErrorReporting(app: App, environment: string) {
  whenPageLoaded(() => {
    whenIdle(() => {
      void loadAndInit(app, environment);
    });
  });
}
