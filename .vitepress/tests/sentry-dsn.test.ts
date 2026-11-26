import { describe, it, expect } from "vitest";
import { SENTRY_DSN, sentryOriginFromDsn } from "../sentry-dsn";

describe("sentryOriginFromDsn", () => {
  it("returns the ingest origin without the public key or project path", () => {
    expect(
      sentryOriginFromDsn("https://publicKey@o123.ingest.us.sentry.io/456"),
    ).toBe("https://o123.ingest.us.sentry.io");
  });

  it("derives an https origin from the committed DSN", () => {
    expect(sentryOriginFromDsn(SENTRY_DSN)).toMatch(
      /^https:\/\/o\d+\.ingest\.[a-z.]*sentry\.io$/,
    );
  });
});
