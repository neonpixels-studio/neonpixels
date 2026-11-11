import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readEnforcedCsp } from "../../../e2e/support/enforcedCsp";

describe("readEnforcedCsp", () => {
  it("returns the enforcing header value, not the commented prose", () => {
    const toml = [
      '    # Content-Security-Policy = "commented"',
      "    Content-Security-Policy = \"default-src 'self'\"",
    ].join("\n");
    expect(readEnforcedCsp(toml)).toBe("default-src 'self'");
  });

  it("ignores a Report-Only header", () => {
    const toml = "Content-Security-Policy-Report-Only = \"default-src 'none'\"";
    expect(() => readEnforcedCsp(toml)).toThrow(/no enforcing/);
  });

  it("reads the real production policy from netlify.toml", () => {
    const toml = readFileSync(resolve(process.cwd(), "netlify.toml"), "utf8");
    const csp = readEnforcedCsp(toml);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://www.googletagmanager.com");
  });
});
