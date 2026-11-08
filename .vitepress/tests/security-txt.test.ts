import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SECURITY_TXT = resolve(
  import.meta.dirname,
  "../../public/.well-known/security.txt",
);
const EXPECTED_CONTACT =
  "https://github.com/neonpixels-studio/grimicorn/security/advisories/new";
const EXPECTED_CANONICAL = "https://neonpixels.dev/.well-known/security.txt";
const RENEWAL_WINDOW_DAYS = 30;
// RFC 9116 section 2.5.5 recommends an Expires less than a year away.
const MAX_EXPIRY_DAYS = 365;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const RFC3339_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function readFields(content: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const line of content.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (line.trimStart().startsWith("#") || separatorIndex === -1) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

describe("/.well-known/security.txt (RFC 9116)", () => {
  const fields = readFields(readFileSync(SECURITY_TXT, "utf8"));

  it("lists the studio's private vulnerability reporting URL as Contact", () => {
    expect(fields.get("contact")).toEqual([EXPECTED_CONTACT]);
  });

  it("declares the production URL of the file as Canonical", () => {
    expect(fields.get("canonical")).toEqual([EXPECTED_CANONICAL]);
  });

  it("declares English as the preferred language", () => {
    expect(fields.get("preferred-languages")).toEqual(["en"]);
  });

  it("has exactly one valid Expires", () => {
    const expiresValues = fields.get("expires") ?? [];
    expect(expiresValues).toHaveLength(1);
    expect(expiresValues[0]).toMatch(RFC3339_UTC_TIMESTAMP);
    // toISOString() throws on Invalid Date; the comparison catches rolled-over dates like Feb 30.
    const parsed = new Date(expiresValues[0]);
    expect(parsed.toISOString().slice(0, 19)).toBe(
      expiresValues[0].slice(0, 19),
    );
  });

  it(`expires between ${RENEWAL_WINDOW_DAYS} and ${MAX_EXPIRY_DAYS} days from now (renew the file when this fails)`, () => {
    const expires = new Date(fields.get("expires")?.[0] ?? "");
    const daysRemaining =
      (expires.getTime() - Date.now()) / MILLISECONDS_PER_DAY;
    expect(daysRemaining).toBeGreaterThan(RENEWAL_WINDOW_DAYS);
    expect(daysRemaining).toBeLessThan(MAX_EXPIRY_DAYS);
  });
});
