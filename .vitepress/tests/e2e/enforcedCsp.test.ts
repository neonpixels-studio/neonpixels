import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnforcedCsp,
  loadGeneratedHeaders,
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
