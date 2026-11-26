import {
  init,
  type BrowserOptions,
  type getDefaultIntegrations,
} from "@sentry/vue";
import {
  DENIED_URLS,
  IGNORED_ERRORS,
  allowUrlsFor,
  scrubEvent,
} from "@neon-pixels/sentry";
import type { App } from "vue";

// v11 no longer re-exports the Integration type from @sentry/vue.
type Integration = ReturnType<typeof getDefaultIntegrations>[number];

// Release-health sessions send one request to Sentry on every page load, error
// or not. Dropped so a visitor who hits no error sends Sentry nothing.
const SESSION_INTEGRATION_NAME = "BrowserSession";
// Raised above the SDK default so beforeSend scrubs whole values instead of
// values already cut mid-secret (see @neon-pixels/sentry's README).
const MAX_VALUE_LENGTH = 8192;

type ErrorReportingOptions = {
  dsn: string;
  environment: string;
  // The origin the page is served from; only scripts from it count as first-party.
  origin: string;
  // Test seam: replaces the network transport so nothing leaves the machine.
  transport?: BrowserOptions["transport"];
};

function withoutSessionTracking(integrations: Integration[]) {
  return integrations.filter(
    (integration) => integration.name !== SESSION_INTEGRATION_NAME,
  );
}

export function initErrorReporting(app: App, options: ErrorReportingOptions) {
  init({
    app,
    dsn: options.dsn,
    environment: options.environment,
    transport: options.transport,
    maxValueLength: MAX_VALUE_LENGTH,
    // Errors only: no tracing, session replay or session tracking.
    integrations: withoutSessionTracking,
    allowUrls: allowUrlsFor([options.origin]),
    denyUrls: [...DENIED_URLS],
    ignoreErrors: [...IGNORED_ERRORS],
    beforeSend: scrubEvent,
    // Discarded-event client reports would send a request for an error the
    // filters dropped, so a visitor with no first-party error sends nothing.
    sendClientReports: false,
    // v11 defaults collect user info (Sentry infers the visitor's IP from it)
    // and cookies, so both are turned off.
    dataCollection: { userInfo: false, cookies: false },
  });
}
