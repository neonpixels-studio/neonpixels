import type { WriteHeadersFileOptions } from "@neon-pixels/security/netlify";

import { SENTRY_INGEST_ORIGIN } from "../sentry-dsn";

// Violation reports go to the security endpoint of this site's Sentry project.
// Both the project id and the key are public values (the same ones as the DSN in
// sentry-dsn.ts), so this lives in the repository like the DSN does. The
// environment is appended per build, see securityReportEndpoint.
export const SENTRY_SECURITY_REPORT_URL =
  "https://o4511543514497024.ingest.us.sentry.io/api/4512493577568256/security/?sentry_key=586e40f6a5b5943d2ca556d0a54ba087";

// Google Analytics (gtag.js) origins follow Google's published CSP guidance
// (developers.google.com/tag-platform/security/guides/csp): gtag.js loads from
// googletagmanager.com, and GA4 sends collection beacons to region-scoped
// *.google-analytics.com / *.analytics.google.com subdomains, hence the
// wildcards. netlify.test.ts allowlists exactly these three wildcard domains;
// every other wildcard fails.
const GOOGLE_TAG_SCRIPT_ORIGIN = "https://www.googletagmanager.com";
const GOOGLE_ANALYTICS_IMAGE_ORIGINS = [
  "https://*.google-analytics.com",
  "https://*.googletagmanager.com",
];
const GOOGLE_ANALYTICS_CONNECT_ORIGINS = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googletagmanager.com",
];

// The package's default Permissions-Policy denies camera, microphone and
// geolocation; these are the rest of the features this site has always denied.
export const EXTRA_DENIED_FEATURES = [
  "payment",
  "usb",
  "browsing-topics",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "midi",
  "serial",
  "hid",
  "bluetooth",
  "display-capture",
  "xr-spatial-tracking",
];

type SiteDirectives = NonNullable<WriteHeadersFileOptions["directives"]>;

// Added to the package's first-party base policy (default-src 'self', object-src
// 'none', base-uri 'self', form-action 'self', frame-ancestors 'none'). Fonts are
// self-hosted, so font-src needs nothing beyond the default.
export const SITE_DIRECTIVES: SiteDirectives = {
  "img-src": ["'self'", ...GOOGLE_ANALYTICS_IMAGE_ORIGINS],
  "script-src": [GOOGLE_TAG_SCRIPT_ORIGIN],
  "connect-src": [
    "'self'",
    ...GOOGLE_ANALYTICS_CONNECT_ORIGINS,
    SENTRY_INGEST_ORIGIN,
  ],
};

// `environment` is Sentry's environment name for the build (production, preview
// or development), resolved from Netlify's CONTEXT in config.ts.
export function securityReportEndpoint(environment: string) {
  return `${SENTRY_SECURITY_REPORT_URL}&sentry_environment=${encodeURIComponent(environment)}`;
}
