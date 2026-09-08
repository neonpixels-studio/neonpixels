import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SMOKE_BUILD_REUSE_DIR_ENV } from "./utils/buildReuse";

const NETLIFY_CONFIG_PATH = resolve(process.cwd(), "netlify.toml");
const HAND_WRITTEN_HEADERS_PATH = resolve(process.cwd(), "public/_headers");
const NVMRC_PATH = resolve(process.cwd(), ".nvmrc");
// Netlify also honours .node-version and .tool-versions (mise/asdf), and reads
// either in preference to .nvmrc, so their presence would silently split the
// single source of truth this test exists to protect.
const NODE_VERSION_FILE_PATH = resolve(process.cwd(), ".node-version");
const TOOL_VERSIONS_PATH = resolve(process.cwd(), ".tool-versions");
const TOOL_VERSIONS_NODE = /^(?:nodejs|node)\s/m;

// Read once at module scope, matching this file's existing convention.
const NETLIFY_CONFIG = readFileSync(NETLIFY_CONFIG_PATH, "utf8");

// The deploy must compile the site exactly once: `npm run build` produces the
// publish dir, then the smoke suite reuses it via SMOKE_BUILD_REUSE_DIR instead
// of compiling a throwaway second copy (see build-html.test.ts). Regressing to a
// separate build step would double the cold-build time this guard exists to stop.
const BUILD_SCRIPT_INVOCATION = "npm run build";
const TEST_SCRIPT_INVOCATION = "npm run test:ci";
// Counts `npm run build` only as a whole script name, so `npm run build:foo`
// neither inflates the count nor passes as the real build.
const BUILD_SCRIPT_PATTERN = /npm run build(?![\w:-])/g;
// The site compiles only via the build script; a bare `vitepress build` in the
// command would be a second compile the reuse wiring is meant to remove.
const DIRECT_COMPILE_INVOCATION = "vitepress build";

// Slice to the [build] table so a `command`/`publish` override in a
// [context.*] table can't make the guard assert against a line the deploy
// never runs.
function readBuildTable() {
  const lines = NETLIFY_CONFIG.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[build]");
  if (start === -1) {
    throw new Error("netlify.toml has no [build] table");
  }
  const rest = lines.slice(start + 1);
  const nextTable = rest.findIndex((line) => /^\s*\[/.test(line));
  const end = nextTable === -1 ? rest.length : nextTable;
  return rest.slice(0, end).join("\n");
}

const BUILD_TABLE = readBuildTable();

function readBuildTableValue(key: string) {
  const match = BUILD_TABLE.match(
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"),
  );
  if (!match) {
    throw new Error(`netlify.toml [build] has no ${key} value`);
  }
  return match[1];
}

// Counts top-level `key = ...` assignments (ignoring commented lines), so a
// `command`/`publish` override in any table can be compared against the count
// inside [build].
function countKeyDefinitions(source: string, key: string) {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => pattern.test(line)).length;
}

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
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const HEADER_LINE = /^\s*([\w-]+)\s*=\s*"([^"]*)"/;

const HEADERS_TABLE_START = /^\s*\[\[headers\]\]/;
const ANY_TABLE_START = /^\s*\[/;
const HEADERS_VALUES_START = /^\s*\[headers\.values\]/;
const GLOBAL_FOR_LINE = /^\s*for\s*=\s*"\/\*"/;

// Slice to the [headers.values] table nested under the [[headers]] block
// whose `for` matches "/*", mirroring readBuildTable() above: a more specific
// block (e.g. `for = "/assets/*"`) added later in the file would otherwise
// let a stray duplicate key silently overwrite the value this suite actually
// needs to assert on, passing green while the deploy serves a different
// value for that path. Takes the config text as a parameter (rather than
// reading the module-level NETLIFY_CONFIG directly) so it can be driven with
// fixtures in tests.
function readGlobalHeadersTable(config: string) {
  const lines = config.split("\n");
  const forLineIndex = lines.findIndex((line) => GLOBAL_FOR_LINE.test(line));
  if (forLineIndex === -1) {
    throw new Error('netlify.toml has no [[headers]] block for "/*"');
  }
  // Confirm that `for` line actually sits inside a [[headers]] table, not
  // some other table that happens to define a same-named key.
  const precedingTables = lines
    .slice(0, forLineIndex)
    .filter((line) => ANY_TABLE_START.test(line));
  const nearestTable = precedingTables.at(-1);
  if (!nearestTable || !HEADERS_TABLE_START.test(nearestTable)) {
    throw new Error(
      'Found `for = "/*"` outside of a [[headers]] table in netlify.toml',
    );
  }
  // Bound the search for [headers.values] to lines still inside this
  // [[headers]] block (up to the next [[headers]] table), so a /* block
  // missing its own [headers.values] table can't fall through and pick up a
  // later, more specific block's values instead.
  const afterFor = lines.slice(forLineIndex + 1);
  const blockEnd = afterFor.findIndex((line) => HEADERS_TABLE_START.test(line));
  const block = blockEnd === -1 ? afterFor : afterFor.slice(0, blockEnd);
  const valuesStart = block.findIndex((line) =>
    HEADERS_VALUES_START.test(line),
  );
  if (valuesStart === -1) {
    throw new Error('The "/*" [[headers]] block has no [headers.values] table');
  }
  const rest = block.slice(valuesStart + 1);
  const nextTable = rest.findIndex((line) => ANY_TABLE_START.test(line));
  const end = nextTable === -1 ? rest.length : nextTable;
  return rest.slice(0, end).join("\n");
}

function parseHeaders(config: string) {
  const globalHeadersTable = readGlobalHeadersTable(config);
  const headers = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const line of globalHeadersTable.split("\n")) {
    const match = line.match(HEADER_LINE);
    if (!match) {
      continue;
    }
    if (headers.has(match[1])) {
      duplicates.add(match[1]);
      continue;
    }
    headers.set(match[1], match[2]);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate header key(s) in the "/*" headers block: ${[...duplicates].join(", ")}`,
    );
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

const headers = parseHeaders(NETLIFY_CONFIG);
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

describe("global headers table scoping", () => {
  it("ignores a same-named key in a more specific [[headers]] block", () => {
    const config = [
      "[[headers]]",
      '  for = "/*"',
      "  [headers.values]",
      '    X-Frame-Options = "DENY"',
      "",
      "[[headers]]",
      '  for = "/assets/*"',
      "  [headers.values]",
      '    X-Frame-Options = "SAMEORIGIN"',
    ].join("\n");
    expect(readHeader(parseHeaders(config), "X-Frame-Options")).toBe("DENY");
  });

  it("throws on a duplicate key within the /* block itself", () => {
    const config = [
      "[[headers]]",
      '  for = "/*"',
      "  [headers.values]",
      '    X-Frame-Options = "DENY"',
      '    X-Frame-Options = "SAMEORIGIN"',
    ].join("\n");
    expect(() => parseHeaders(config)).toThrow(/Duplicate header key/);
  });

  it("does not read keys from an unrelated single-bracket table after the block", () => {
    const config = [
      "[[headers]]",
      '  for = "/*"',
      "  [headers.values]",
      '    X-Frame-Options = "DENY"',
      "",
      "[build.environment]",
      '    NODE_VERSION = "20"',
    ].join("\n");
    expect(() => readHeader(parseHeaders(config), "NODE_VERSION")).toThrow(
      /Missing "NODE_VERSION" header/,
    );
  });

  it('throws when for = "/*" appears outside a [[headers]] table', () => {
    const config = ["[build]", '  for = "/*"'].join("\n");
    expect(() => parseHeaders(config)).toThrow(
      /outside of a \[\[headers\]\] table/,
    );
  });

  it('throws when no [[headers]] block for "/*" exists at all', () => {
    const config = ["[build]", '  publish = "dist"'].join("\n");
    expect(() => parseHeaders(config)).toThrow(
      /no \[\[headers\]\] block for "\/\*"/,
    );
  });

  it("throws when the /* block has no [headers.values] table of its own, even if a later block has one", () => {
    const config = [
      "[[headers]]",
      '  for = "/*"',
      "",
      "[[headers]]",
      '  for = "/assets/*"',
      "  [headers.values]",
      '    X-Frame-Options = "SAMEORIGIN"',
    ].join("\n");
    expect(() => parseHeaders(config)).toThrow(/no \[headers\.values\] table/);
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

describe("Netlify build compiles the site once", () => {
  const buildCommand = readBuildTableValue("command");
  const publishDir = readBuildTableValue("publish");
  const reuseAssignment = `${SMOKE_BUILD_REUSE_DIR_ENV}=${publishDir}`;

  it("invokes the build script exactly once", () => {
    expect(buildCommand.match(BUILD_SCRIPT_PATTERN) ?? []).toHaveLength(1);
  });

  it("never compiles the site outside the build script", () => {
    expect(buildCommand).not.toContain(DIRECT_COMPILE_INVOCATION);
  });

  it("runs the smoke suite after the single build so reuse has an artifact", () => {
    const buildIndex = buildCommand.indexOf(BUILD_SCRIPT_INVOCATION);
    const suiteIndex = buildCommand.indexOf(TEST_SCRIPT_INVOCATION);
    expect(suiteIndex).toBeGreaterThan(buildIndex);
  });

  it("binds the reuse flag to the smoke suite, not the build", () => {
    const buildIndex = buildCommand.indexOf(BUILD_SCRIPT_INVOCATION);
    expect(buildCommand.indexOf(reuseAssignment)).toBeGreaterThan(buildIndex);
  });

  // A [context.*] table's `command` overrides [build].command on Netlify, so a
  // double-build hidden there would run in production while the [build] slice
  // still looks clean. Assert the deploy command lives only in [build].
  it.each(["command", "publish"])(
    "defines %s only in the [build] table",
    (key) => {
      const occurrences = countKeyDefinitions(NETLIFY_CONFIG, key);
      const inBuild = countKeyDefinitions(BUILD_TABLE, key);
      expect(occurrences).toBe(inBuild);
    },
  );
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

describe("shipped immutable asset caching", () => {
  // netlify.toml and _headers are merged, and for a header both set on
  // overlapping paths netlify.toml wins. A Cache-Control added to its /*
  // block would silently override the /assets/* immutable rule declared in
  // _headers (see build-html.test.ts for the build-verified half of this
  // invariant: that every shipped /assets/ file is content-hashed and that
  // _headers actually carries the rule). Match an actual Cache-Control
  // assignment (bare or quoted key), not the bare string, so a comment
  // mentioning Cache-Control — whole-line or trailing — can't false-trigger
  // the guard. Any real assignment (overlapping path or not) still fails,
  // forcing a deliberate review of the _headers/netlify.toml interaction.
  //
  // This is a static check of netlify.toml alone, so unlike the build-html.test.ts
  // checks it references, it runs without paying for a VitePress build.
  it("does not let netlify.toml override the immutable asset cache", () => {
    expect(NETLIFY_CONFIG).not.toMatch(/^\s*"?Cache-Control"?\s*=/m);
  });
});

// writeReportOnlyHeaders (.vitepress/csp) already fails loud if the build-time
// noindex line collides with a *hand-written* header inside its own generated
// block (see writeReportOnlyHeaders.test.ts), but that check only sees what's
// in the publish dir's _headers at build time. Neither source file it's built
// from — netlify.toml's global /* block, or the public/_headers VitePress
// copies in verbatim — is covered by that runtime check, so both need a
// static guard instead. Both checks are static reads of repo files, so — like
// "shipped immutable asset caching" above — they run without paying for a
// VitePress build (see build-html.test.ts, where these guards previously lived
// gated behind the 120s build suite).
describe("noindex header ownership", () => {
  // netlify.toml and _headers are merged, and for a header both set on
  // overlapping paths netlify.toml wins. A hand-added X-Robots-Tag there would
  // silently win over (or, on preview contexts, mask) the noindex header
  // generated into _headers (see .vitepress/robots), with every _headers
  // assertion still passing. Case-insensitive (`im`): TOML keys are
  // case-sensitive but Netlify applies HTTP header names case-insensitively,
  // so `x-robots-tag` or `X-ROBOTS-TAG` would create the same hazard a
  // case-sensitive match would miss entirely. Not line-anchored: TOML permits
  // `-` in a bare key, so an inline-table assignment like
  // `values = { X-Robots-Tag = "index" }` would sail past a `^`-anchored
  // match despite setting the header — the exact hazard this guard exists to
  // block.
  it("does not let netlify.toml declare its own X-Robots-Tag", () => {
    expect(NETLIFY_CONFIG).not.toMatch(/"?X-Robots-Tag"?\s*=/i);
  });

  // public/_headers is the hand-written file writeReportOnlyHeaders treats as
  // pre-existing content and carries forward as-is (see handWrittenHeaders) —
  // an X-Robots-Tag added here, e.g. alongside the /assets/* rule, ships
  // unconditionally on every context, including production, with no build
  // failure and no _headers assertion noticing.
  it("does not let public/_headers declare its own X-Robots-Tag", () => {
    const handWrittenHeaders = readFileSync(HAND_WRITTEN_HEADERS_PATH, "utf8");
    expect(handWrittenHeaders).not.toMatch(/^\s*X-Robots-Tag\s*:/im);
  });
});
