import { describe, expect, it } from "vitest";

import { SITE_DIRECTIVES } from "../../csp/sitePolicy";
import { SENTRY_INGEST_ORIGIN } from "../../sentry-dsn";

describe("SITE_DIRECTIVES", () => {
  it("never allows inline or eval sources", () => {
    const sources = Object.values(SITE_DIRECTIVES).flat();
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
  });

  it("allows the Sentry ingest origin for the browser SDK", () => {
    expect(SITE_DIRECTIVES["connect-src"]).toContain(SENTRY_INGEST_ORIGIN);
  });
});
