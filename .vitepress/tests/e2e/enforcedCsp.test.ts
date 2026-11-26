import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnforcedCsp,
  loadGeneratedHeaders,
  localizeReporting,
  LOCAL_REPORT_PATH,
  readEnforcedCsp,
  readGlobalHeaders,
} from "../../../e2e/support/enforcedCsp";
import { generateFixtureHeaders } from "../utils/generatedHeaders";

describe("readGlobalHeaders", () => {
  it("reads every header of the /* block", () => {
    const headersFile = [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  Content-Security-Policy: default-src 'self'; report-uri https://a.test/x?k=v",
    ].join("\n");
    expect(readGlobalHeaders(headersFile)).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; report-uri https://a.test/x?k=v",
    });
  });

  it("merges more than one /* block and skips other paths and comments", () => {
    const headersFile = [
      "# cache rules",
      "/assets/*",
      "  Cache-Control: public, immutable",
      "",
      "/*",
      "  A: 1",
      "",
      "/*",
      "  B: 2",
    ].join("\n");
    expect(readGlobalHeaders(headersFile)).toEqual({ A: "1", B: "2" });
  });
});

describe("readGlobalHeaders strictness", () => {
  it("throws when a header is set twice for /*, because Netlify would serve both", () => {
    const headersFile = "/*\n  X-A: 1\n\n/*\n  x-a: 2";
    expect(() => readGlobalHeaders(headersFile)).toThrow(/set twice/);
  });

  it("allows the same header on different paths", () => {
    const headersFile = "/a/*\n  X-A: 1\n\n/*\n  X-A: 2";
    expect(readGlobalHeaders(headersFile)).toEqual({ "X-A": "2" });
  });

  it("throws on an indented line that is not a header instead of reading it as a path", () => {
    const headersFile = "/*\n  X-A:\n  X-B: 2";
    expect(() => readGlobalHeaders(headersFile)).toThrow(
      /not a valid header line/,
    );
  });
});

describe("localizeReporting", () => {
  const generated = {
    "Content-Security-Policy":
      "default-src 'self'; report-uri https://o1.ingest.sentry.io/api/2/security/?sentry_key=k&sentry_environment=development; report-to csp-endpoint",
    "Reporting-Endpoints":
      'csp-endpoint="https://o1.ingest.sentry.io/api/2/security/?sentry_key=k"',
    "X-Frame-Options": "DENY",
  };

  it("points both report destinations at the e2e server", () => {
    const localized = localizeReporting(generated);
    expect(localized["Content-Security-Policy"]).toBe(
      `default-src 'self'; report-uri ${LOCAL_REPORT_PATH}; report-to csp-endpoint`,
    );
    expect(localized["Reporting-Endpoints"]).toBe(
      `csp-endpoint="${LOCAL_REPORT_PATH}"`,
    );
  });

  it("leaves every other header alone and never mutates its input", () => {
    const localized = localizeReporting(generated);
    expect(localized["X-Frame-Options"]).toBe("DENY");
    expect(generated["Reporting-Endpoints"]).toContain("sentry.io");
  });

  it("leaves no Sentry report endpoint once localized", async () => {
    const served = localizeReporting(
      readGlobalHeaders(await generateFixtureHeaders()),
    );
    // The SDK's ingest origin stays in connect-src; only the report endpoint goes.
    expect(JSON.stringify(served)).not.toContain("/security/");
    expect(JSON.stringify(served)).toContain(LOCAL_REPORT_PATH);
  });
});

describe("readEnforcedCsp", () => {
  it("returns the enforcing header value", () => {
    const headersFile = "/*\n  Content-Security-Policy: default-src 'self'";
    expect(readEnforcedCsp(headersFile)).toBe("default-src 'self'");
  });

  it("ignores a Report-Only header", () => {
    const headersFile =
      "/*\n  Content-Security-Policy-Report-Only: default-src 'none'";
    expect(() => readEnforcedCsp(headersFile)).toThrow(/no enforcing/);
  });

  it("ignores a policy declared for another path", () => {
    const headersFile =
      "/other/*\n  Content-Security-Policy: default-src 'self'";
    expect(() => readEnforcedCsp(headersFile)).toThrow(/no enforcing/);
  });
});

describe("generated headers on disk", () => {
  it("reads the policy and the other headers the build wrote", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "np-enforced-csp-"));
    try {
      writeFileSync(join(distDir, "_headers"), await generateFixtureHeaders());
      expect(loadEnforcedCsp(distDir)).toContain("default-src 'self'");
      expect(loadEnforcedCsp(distDir)).toContain(
        "https://www.googletagmanager.com",
      );
      expect(loadGeneratedHeaders(distDir)["X-Frame-Options"]).toBe("DENY");
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  });
});
