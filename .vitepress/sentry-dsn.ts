// The Sentry DSN is a public value (it only lets a client send events), so it is
// committed as a constant. Shared by the browser SDK setup and the CSP test.
export const SENTRY_DSN =
  "https://586e40f6a5b5943d2ca556d0a54ba087@o4511543514497024.ingest.us.sentry.io/4512493577568256";

// The origin the browser SDK posts events to, for connect-src.
export function sentryOriginFromDsn(dsn: string) {
  return new URL(dsn).origin;
}
