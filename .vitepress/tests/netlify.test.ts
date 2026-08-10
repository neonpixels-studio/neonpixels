import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NETLIFY_CONFIG_PATH = resolve(process.cwd(), "netlify.toml");

// One year is the recommended HSTS floor for an HTTPS-only site; we serve two.
const HSTS_MIN_MAX_AGE_SECONDS = 31536000;

const STATIC_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const HEADER_LINE = /^\s*([\w-]+)\s*=\s*"([^"]*)"/;

function parseHeaders() {
  const config = readFileSync(NETLIFY_CONFIG_PATH, "utf8");
  const headers = new Map<string, string>();
  for (const line of config.split("\n")) {
    const match = line.match(HEADER_LINE);
    if (match) {
      headers.set(match[1], match[2]);
    }
  }
  return headers;
}

function readHeader(headers: Map<string, string>, name: string) {
  const value = headers.get(name);
  if (value === undefined) {
    throw new Error(`Missing "${name}" header in netlify.toml`);
  }
  return value;
}

function parseDirectives(headerValue: string) {
  return headerValue
    .split(";")
    .map((directive) => directive.trim().toLowerCase());
}

function parseHstsMaxAge(headerValue: string) {
  const match = headerValue.match(/(?:^|;\s*)max-age\s*=\s*(\d+)/i);
  if (!match) {
    throw new Error(`HSTS header has no max-age directive: "${headerValue}"`);
  }
  return Number(match[1]);
}

// The exact source set each directive is allowed to carry. Asserted as an
// exact match (not a subset), so appending a rogue origin to any directive
// fails the suite, not just widening to a bare wildcard. Grounded in what the
// built site actually loads: self, Google Fonts (stylesheet from
// fonts.googleapis.com, font files from fonts.gstatic.com), and the
// 'unsafe-inline' that VitePress's inline bootstrap scripts and the
// components' inline style attributes require.
const EXPECTED_CSP_SOURCES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "img-src": ["'self'"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "connect-src": ["'self'"],
  "form-action": ["'self'"],
};

// Scheme-only allow-alls and eval that would silently defeat the policy. Any
// source containing "*" is caught separately as a wildcard. None are
// legitimate for this static site.
const OVERLY_BROAD_SOURCES = new Set([
  "http:",
  "https:",
  "data:",
  "blob:",
  "ws:",
  "wss:",
  "'unsafe-eval'",
]);

// Hashes and nonces are base64 and case-sensitive; every other CSP token
// (keywords, schemes, hosts) is case-insensitive to the browser. Lowercasing a
// hash would let a hash no browser matches pass the suite, so preserve its case.
const CASE_SENSITIVE_SOURCE = /^'(?:sha(?:256|384|512)|nonce)-/i;

function normalizeSource(source: string) {
  if (CASE_SENSITIVE_SOURCE.test(source)) {
    return source;
  }
  return source.toLowerCase();
}

// A browser enforces the FIRST occurrence of a duplicated directive and ignores
// the rest, so a duplicate makes the header document a policy it does not have.
// Parse first-wins to match the browser, but surface duplicates so the suite
// fails loud instead of silently trusting a misconfigured file.
function parseCsp(headerValue: string) {
  const directives = new Map<string, string[]>();
  const duplicates: string[] = [];
  for (const directive of headerValue.split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const name = tokens[0].toLowerCase();
    if (directives.has(name)) {
      duplicates.push(name);
      continue;
    }
    directives.set(name, tokens.slice(1).map(normalizeSource));
  }
  return { directives, duplicates };
}

function isOverlyBroadSource(source: string) {
  if (source.includes("*")) {
    return true;
  }
  return OVERLY_BROAD_SOURCES.has(source);
}

const headers = parseHeaders();
const { directives: cspDirectives, duplicates: cspDuplicates } = parseCsp(
  readHeader(headers, "Content-Security-Policy"),
);

describe("netlify security headers", () => {
  it.each(Object.entries(STATIC_HEADERS))(
    "serves %s with the expected value",
    (name, expectedValue) => {
      expect(readHeader(headers, name)).toBe(expectedValue);
    },
  );

  it("sends an HSTS max-age of at least one year", () => {
    const maxAge = parseHstsMaxAge(
      readHeader(headers, "Strict-Transport-Security"),
    );
    expect(maxAge).toBeGreaterThanOrEqual(HSTS_MIN_MAX_AGE_SECONDS);
  });

  it("extends HSTS to all subdomains", () => {
    const directives = parseDirectives(
      readHeader(headers, "Strict-Transport-Security"),
    );
    expect(directives).toContain("includesubdomains");
  });
});

describe("Content-Security-Policy", () => {
  it("declares no duplicate directives", () => {
    expect(cspDuplicates).toEqual([]);
  });

  it("declares exactly the expected directives", () => {
    expect([...cspDirectives.keys()].sort()).toEqual(
      Object.keys(EXPECTED_CSP_SOURCES).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_CSP_SOURCES))(
    "scopes %s to exactly its expected sources",
    (directive, expectedSources) => {
      const sources = cspDirectives.get(directive) ?? [];
      expect([...sources].sort()).toEqual([...expectedSources].sort());
    },
  );

  // Guards the expectation table itself: exact-match already pins the live
  // header to this table, so an overly broad source can only slip in by someone
  // relaxing the table. This is the check that catches that.
  it("keeps the expected source table free of overly broad sources", () => {
    const broad = Object.entries(EXPECTED_CSP_SOURCES).flatMap(
      ([directive, sources]) =>
        sources
          .filter(isOverlyBroadSource)
          .map((source) => `${directive}: ${source}`),
    );
    expect(broad).toEqual([]);
  });
});
