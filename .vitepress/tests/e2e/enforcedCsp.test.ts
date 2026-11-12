import { describe, it, expect } from "vitest";
import {
  loadEnforcedCsp,
  readEnforcedCsp,
} from "../../../e2e/support/enforcedCsp";

describe("readEnforcedCsp", () => {
  it("returns the enforcing header value, not the commented prose", () => {
    const toml = [
      '    # Content-Security-Policy = "commented"',
      "    Content-Security-Policy = \"default-src 'self'\"",
    ].join("\n");
    expect(readEnforcedCsp(toml)).toBe("default-src 'self'");
  });

  it("rejects a policy containing escapes instead of serving it mangled", () => {
    expect(() =>
      readEnforcedCsp('Content-Security-Policy = "a \\" b"'),
    ).toThrow();
  });

  it("ignores a Report-Only header", () => {
    const toml = "Content-Security-Policy-Report-Only = \"default-src 'none'\"";
    expect(() => readEnforcedCsp(toml)).toThrow(/no enforcing/);
  });

  it("reads the real production policy from netlify.toml", () => {
    const csp = loadEnforcedCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://www.googletagmanager.com");
  });
});
