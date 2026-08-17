import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const NETLIFY_CONFIG_PATH = resolve(process.cwd(), "netlify.toml");
const NVMRC_PATH = resolve(process.cwd(), ".nvmrc");
// Netlify also honours .node-version and .tool-versions (mise/asdf), and reads
// either in preference to .nvmrc, so their presence would silently split the
// single source of truth this test exists to protect.
const NODE_VERSION_FILE_PATH = resolve(process.cwd(), ".node-version");
const TOOL_VERSIONS_PATH = resolve(process.cwd(), ".tool-versions");
const TOOL_VERSIONS_NODE = /^(?:nodejs|node)\s/m;

// Read once at module scope, matching this file's existing convention.
const NETLIFY_CONFIG = readFileSync(NETLIFY_CONFIG_PATH, "utf8");

// The Node version lives in .nvmrc only (read by CI and Netlify alike). This
// test is the sole in-repo record of which major we build on, so it pins the
// major and the exact-patch shape; a drift to another major (or a floating
// value) fails here. An optional leading `v` is accepted — nvm, setup-node,
// and Netlify all take it.
const EXPECTED_NODE_MAJOR = 24;
const EXACT_NODE_VERSION = /^v?\d+\.\d+\.\d+$/;

// Matches a NODE_VERSION assignment in any form Netlify parses: a section key,
// a quoted key, a dotted key (`build.environment.NODE_VERSION = ...`), or an
// inline-table entry (`{ NODE_VERSION = ... }`).
const NODE_VERSION_PIN = /(?:^|[\s{,.])"?NODE_VERSION"?\s*=/;

// True only when the pin survives comment stripping, so a live pin on a line
// whose earlier value contains `#` still counts while a comment-only mention
// ("# NODE_VERSION ...") does not.
function lineHasLivePin(line: string) {
  return (
    NODE_VERSION_PIN.test(line) && NODE_VERSION_PIN.test(line.split("#", 1)[0])
  );
}

// Returns the 1-based line number of the pin, or undefined if none, so a
// failure points at where to look rather than at a comment-stripped fragment.
function findNodeVersionPinLine() {
  const index = NETLIFY_CONFIG.split("\n").findIndex(lineHasLivePin);
  return index === -1 ? undefined : index + 1;
}

function readNodeMajor(version: string) {
  return Number(version.replace(/^v/, "").split(".")[0]);
}

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
  const headers = new Map<string, string>();
  for (const line of NETLIFY_CONFIG.split("\n")) {
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
// built site actually loads: self only (fonts are self-hosted via @fontsource,
// so no Google Fonts origins) plus the 'unsafe-inline' that VitePress's inline
// bootstrap scripts and the components' inline style attributes require.
const EXPECTED_CSP_SOURCES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "img-src": ["'self'"],
  "font-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "connect-src": ["'self'"],
  "form-action": ["'self'"],
};

// Fonts are self-hosted, so any Google Fonts origin is a dead allowlist entry.
// Matched by bare domain (not exact host) so a re-add via a subdomain, port, or
// wildcard variant also trips this guard (see issue #28).
const DROPPED_GOOGLE_FONTS_DOMAINS = ["gstatic.com", "googleapis.com"];

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
const cspHeaderValue = readHeader(headers, "Content-Security-Policy");
const { directives: cspDirectives, duplicates: cspDuplicates } =
  parseCsp(cspHeaderValue);

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

describe("Node version source of truth", () => {
  it("does not hardcode NODE_VERSION in netlify.toml", () => {
    const pinLine = findNodeVersionPinLine();
    expect(
      pinLine,
      `netlify.toml:${pinLine} pins NODE_VERSION; delete it and let Netlify read .nvmrc`,
    ).toBeUndefined();
  });

  it("pins the expected exact Node version in .nvmrc for Netlify to auto-read", () => {
    expect(existsSync(NVMRC_PATH)).toBe(true);
    const nvmrc = readFileSync(NVMRC_PATH, "utf8").trim();
    expect(nvmrc).toMatch(EXACT_NODE_VERSION);
    expect(readNodeMajor(nvmrc)).toBe(EXPECTED_NODE_MAJOR);
  });

  it("keeps .nvmrc the only Node version file", () => {
    expect(existsSync(NODE_VERSION_FILE_PATH)).toBe(false);
    const toolVersions = existsSync(TOOL_VERSIONS_PATH)
      ? readFileSync(TOOL_VERSIONS_PATH, "utf8")
      : "";
    expect(TOOL_VERSIONS_NODE.test(toolVersions)).toBe(false);
  });
});

describe("Content-Security-Policy", () => {
  it("declares no duplicate directives", () => {
    expect(cspDuplicates).toEqual([]);
  });

  it.each(DROPPED_GOOGLE_FONTS_DOMAINS)(
    "no longer allowlists any %s origin now that fonts are self-hosted",
    (domain) => {
      expect(cspHeaderValue).not.toContain(domain);
    },
  );

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
