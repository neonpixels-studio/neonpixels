import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import config from "../config";
import type { HeadConfig } from "vitepress";

// Cross-checks the origins the configured `head` loads against the CSP in netlify.toml
// in both directions: every external origin a head entry fetches must be granted by the
// matching CSP directive, and every external origin the CSP grants must be referenced by
// a head entry (bar a documented baseline). Scope note: only `config.head` is inspected —
// resources reached via a theme layout, `transformHead`, or a CSS `@import` are invisible
// here (the theme-CSS surface is covered separately by config.test.ts).

const NETLIFY_CONFIG_PATH = resolve(process.cwd(), "netlify.toml");

// The site's own origin, so absolute self-hosted URLs (canonical, og:url, favicons
// declared as full https URLs) count as local and are never treated as third-party.
// Computed from the sitemap hostname; a schemeless or malformed value falls back to a
// sentinel rather than crashing collection.
const FALLBACK_ORIGIN = "https://neonpixels.invalid";
const SITE_ORIGIN = (() => {
  const hostname = config.sitemap?.hostname;
  if (!hostname) {
    return FALLBACK_ORIGIN;
  }
  const withScheme = hostname.includes("://")
    ? hostname
    : `https://${hostname}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return FALLBACK_ORIGIN;
  }
})();

// Maps a head entry that fetches a subresource to the CSP directive that governs it.
// A `<link rel=preload>` is routed by its `as` attribute instead (PRELOAD_AS_DIRECTIVE).
const REL_DIRECTIVE: Record<string, string> = {
  stylesheet: "style-src",
  modulepreload: "script-src",
  icon: "img-src",
  "apple-touch-icon": "img-src",
  "mask-icon": "img-src",
  manifest: "manifest-src",
};

// `<link rel=preload as=...>` names the destination explicitly; map it to its directive.
// Destinations follow CSP Level 3's fetch-directive table (track/audio/video → media-src).
const PRELOAD_AS_DIRECTIVE: Record<string, string> = {
  script: "script-src",
  style: "style-src",
  font: "font-src",
  image: "img-src",
  fetch: "connect-src",
  track: "media-src",
  audio: "media-src",
  video: "media-src",
};

// A preload whose `as` we don't recognize can't be verified against a specific directive,
// so it must fail the cross-check loudly rather than fall back to "any fetch directive".
const UNSUPPORTED_PRELOAD_DIRECTIVE = "unsupported-preload-destination";

// Connection hints and speculative fetches don't name a destination directive, so the
// origin must be granted by *some* fetch directive. `directive: null` marks these.
const CONNECTION_HINT_RELS = new Set([
  "preconnect",
  "dns-prefetch",
  "prefetch",
]);

// The fetch directives a connection-hint origin may legitimately be satisfied by.
const FETCH_DIRECTIVES = [
  "script-src",
  "style-src",
  "font-src",
  "img-src",
  "connect-src",
  "media-src",
  "manifest-src",
];

// The directives that can carry a host origin the browser fetches, so an unreferenced
// origin under any of them is worth flagging. Excludes directives that only hold keywords
// or non-loadable URLs (base-uri, frame-ancestors, form-action, report-*).
const CSP_ORIGIN_DIRECTIVES = [
  ...FETCH_DIRECTIVES,
  "default-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
];

// The CSP still grants these Google Fonts origins from before the site self-hosted its
// fonts (.vitepress/theme/index.ts); no head entry references them any longer. Listed so
// the reverse cross-check passes while they linger — a *new* unreferenced CSP origin still
// fails. A dedicated test asserts each is still present, so this list retires itself the
// moment the CSP drops them. Removing them from the CSP is a follow-up, not this change.
const CSP_ORIGINS_WITHOUT_HEAD_ENTRY = new Set([
  "https://fonts.gstatic.com",
  "https://fonts.googleapis.com",
]);

// The tuple variants of HeadConfig (it is also allowed to be a bare string).
type HeadEntry = Extract<HeadConfig, unknown[]>;
type HeadOrigin = { source: string; origin: string; directive: string | null };
type CspDirectives = Map<string, string[]>;

// Returns the external origin of an absolute http(s) URL, or null for a relative URL, a
// non-http scheme, a same-site URL, or an unparseable value. Relative URLs (e.g.
// "/images/x.svg") throw without a base and are correctly treated as local.
function externalOrigin(url: string | undefined) {
  if (typeof url !== "string") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  if (parsed.origin === SITE_ORIGIN) {
    return null;
  }
  return parsed.origin;
}

// A CSP host-source may omit the scheme (CSP3 §6.6.2.6), e.g. `cdn.example.com`. Returns
// the external origin such a source grants, or null for keywords ('self', 'none', hashes),
// scheme-only sources (data:, https:), wildcards, and same-site hosts.
function cspSourceOrigin(source: string) {
  if (source.startsWith("'") || source.includes("*")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
    return null;
  }
  const withScheme = source.includes("://") ? source : `https://${source}`;
  return externalOrigin(withScheme);
}

function relTokens(attributes: Record<string, string> | undefined) {
  return (attributes?.rel ?? "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function directiveForLink(attributes: Record<string, string> | undefined) {
  const tokens = relTokens(attributes);
  if (tokens.includes("preload")) {
    const asValue = (attributes?.as ?? "").toLowerCase();
    const directive = Object.hasOwn(PRELOAD_AS_DIRECTIVE, asValue)
      ? PRELOAD_AS_DIRECTIVE[asValue]
      : UNSUPPORTED_PRELOAD_DIRECTIVE;
    return { directive, label: `[as=${asValue || "?"}]` };
  }
  const mapped = tokens.find((token) => Object.hasOwn(REL_DIRECTIVE, token));
  if (mapped) {
    return { directive: REL_DIRECTIVE[mapped], label: `[rel=${mapped}]` };
  }
  const hint = tokens.find((token) => CONNECTION_HINT_RELS.has(token));
  if (hint) {
    return { directive: null, label: `[rel=${hint}]` };
  }
  return null;
}

function headOriginFromLink(attributes: Record<string, string> | undefined) {
  const mapping = directiveForLink(attributes);
  if (!mapping) {
    return null;
  }
  const origin = externalOrigin(attributes?.href);
  if (!origin) {
    return null;
  }
  return {
    source: `link${mapping.label}`,
    origin,
    directive: mapping.directive,
  };
}

function headOriginFromScript(attributes: Record<string, string> | undefined) {
  const origin = externalOrigin(attributes?.src);
  if (!origin) {
    return null;
  }
  return { source: "script[src]", origin, directive: "script-src" };
}

function headOriginFor(entry: HeadEntry): HeadOrigin | null {
  const [tag, attributes] = entry;
  if (tag === "script") {
    return headOriginFromScript(attributes);
  }
  if (tag === "link") {
    return headOriginFromLink(attributes);
  }
  return null;
}

// Every external origin the configured head actually loads, paired with the CSP
// directive that must grant it (null = any fetch directive, for connection hints).
function externalHeadOrigins(head: readonly HeadConfig[]) {
  return head
    .filter((entry): entry is HeadEntry => Array.isArray(entry))
    .map(headOriginFor)
    .filter((entry): entry is HeadOrigin => entry !== null);
}

const HEADER_LINE = /^\s*([\w-]+)\s*=\s*"([^"]*)"/;

// Pure so the missing/empty-header paths are testable without touching the filesystem.
function extractCspHeader(netlifyConfig: string) {
  for (const line of netlifyConfig.split("\n")) {
    const match = line.match(HEADER_LINE);
    if (!match || match[1].toLowerCase() !== "content-security-policy") {
      continue;
    }
    const value = match[2].trim();
    if (!value) {
      throw new Error(
        "Content-Security-Policy in netlify.toml is empty or not a single-line double-quoted value",
      );
    }
    return value;
  }
  throw new Error("Missing Content-Security-Policy header in netlify.toml");
}

function readCspHeader() {
  return extractCspHeader(readFileSync(NETLIFY_CONFIG_PATH, "utf8"));
}

// Parse the CSP into directive -> sources. First occurrence wins, mirroring how a
// browser enforces a duplicated directive, so coverage is judged against the live policy.
function parseCsp(headerValue: string): CspDirectives {
  const directives: CspDirectives = new Map();
  for (const directive of headerValue.split(";")) {
    const tokens = directive.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const name = tokens[0].toLowerCase();
    if (directives.has(name)) {
      continue;
    }
    directives.set(name, tokens.slice(1));
  }
  return directives;
}

// A fetch directive falls back to default-src when it is not declared (CSP semantics).
function grantedSourcesFor(directive: string, directives: CspDirectives) {
  const own = directives.get(directive);
  if (own !== undefined) {
    return own;
  }
  return directives.get("default-src") ?? [];
}

function sourceCoversOrigin(source: string, origin: string) {
  if (source === "*") {
    return true;
  }
  const target = new URL(origin);
  if (source === target.protocol) {
    return true;
  }
  // `*.example.com` matches a sub-domain but not the apex; compare on hostname so a port
  // on the origin never defeats the match.
  const wildcardHost = source.match(/^(?:https?:\/\/)?\*\.(.+)$/i);
  if (wildcardHost) {
    const domain = wildcardHost[1].toLowerCase();
    return target.hostname.toLowerCase().endsWith(`.${domain}`);
  }
  return cspSourceOrigin(source) === origin;
}

function originGranted(
  origin: string,
  directive: string | null,
  directives: CspDirectives,
) {
  if (directive === UNSUPPORTED_PRELOAD_DIRECTIVE) {
    return false;
  }
  if (directive === null) {
    return FETCH_DIRECTIVES.some((fetchDirective) =>
      grantedSourcesFor(fetchDirective, directives).some((source) =>
        sourceCoversOrigin(source, origin),
      ),
    );
  }
  return grantedSourcesFor(directive, directives).some((source) =>
    sourceCoversOrigin(source, origin),
  );
}

// Every concrete external origin the CSP grants across its origin-bearing directives,
// deduped. Keywords, scheme-only and wildcard sources resolve to null and drop out — they
// are not origins a head entry can be matched to.
function cspExternalOrigins(directives: CspDirectives) {
  const origins = CSP_ORIGIN_DIRECTIVES.flatMap(
    (name) => directives.get(name) ?? [],
  )
    .map(cspSourceOrigin)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}

// The forward check: external origins a head entry loads that the CSP fails to grant.
function uncoveredHeadOrigins(
  head: readonly HeadConfig[],
  directives: CspDirectives,
) {
  return externalHeadOrigins(head)
    .filter(
      (entry) => !originGranted(entry.origin, entry.directive, directives),
    )
    .map(
      (entry) =>
        `${entry.source} ${entry.origin} needs ${entry.directive ?? "a fetch directive"}`,
    );
}

// The reverse check: external origins the CSP grants that no head entry references (minus
// the documented baseline of origins retained for reasons outside config.head).
function unbackedCspOrigins(
  head: readonly HeadConfig[],
  directives: CspDirectives,
) {
  const loadedOrigins = new Set(
    externalHeadOrigins(head).map((entry) => entry.origin),
  );
  return cspExternalOrigins(directives).filter(
    (origin) =>
      !loadedOrigins.has(origin) && !CSP_ORIGINS_WITHOUT_HEAD_ENTRY.has(origin),
  );
}

const cspDirectives = parseCsp(readCspHeader());
const cspOrigins = cspExternalOrigins(cspDirectives);

describe("external head origin extraction", () => {
  const sample: HeadConfig[] = [
    ["script", { src: "https://cdn.example.com/a.js" }],
    ["script", { type: "application/ld+json" }, "{}"],
    ["link", { rel: "stylesheet", href: "https://widgets.example.com/w.css" }],
    ["link", { rel: "stylesheet", href: `${SITE_ORIGIN}/assets/site.css` }],
    ["link", { rel: "preconnect", href: "https://hints.example.com" }],
    [
      "link",
      { rel: "preload", as: "font", href: "https://f.example.com/x.woff2" },
    ],
    ["link", { rel: "canonical", href: SITE_ORIGIN }],
    ["link", { rel: "icon", href: "/images/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#000" }],
  ];

  it("maps each external resource entry to its CSP directive", () => {
    expect(externalHeadOrigins(sample)).toEqual([
      {
        source: "script[src]",
        origin: "https://cdn.example.com",
        directive: "script-src",
      },
      {
        source: "link[rel=stylesheet]",
        origin: "https://widgets.example.com",
        directive: "style-src",
      },
      {
        source: "link[rel=preconnect]",
        origin: "https://hints.example.com",
        directive: null,
      },
      {
        source: "link[as=font]",
        origin: "https://f.example.com",
        directive: "font-src",
      },
    ]);
  });

  it("flags a preload with an unrecognized destination instead of waving it through", () => {
    const entry: HeadConfig = [
      "link",
      { rel: "preload", as: "embed", href: "https://cdn.example.com/x.swf" },
    ];
    expect(externalHeadOrigins([entry])).toEqual([
      {
        source: "link[as=embed]",
        origin: "https://cdn.example.com",
        directive: UNSUPPORTED_PRELOAD_DIRECTIVE,
      },
    ]);
  });

  it("excludes inline scripts, same-site URLs, relative hrefs and non-resource tags", () => {
    const excluded: HeadConfig[] = [
      ["script", { type: "application/ld+json" }, "{}"],
      ["link", { rel: "stylesheet", href: `${SITE_ORIGIN}/assets/site.css` }],
      ["link", { rel: "preconnect", href: SITE_ORIGIN }],
      ["link", { rel: "icon", href: "/images/favicon.svg" }],
      ["meta", { name: "theme-color", content: "#000" }],
    ];
    for (const entry of excluded) {
      expect(externalHeadOrigins([entry])).toEqual([]);
    }
  });
});

describe("CSP coverage engine", () => {
  const policy = parseCsp(
    "default-src 'self'; font-src https://f.test; style-src 'self' https://*.cdn.test; connect-src *",
  );

  it("treats an origin the policy grants as covered", () => {
    expect(originGranted("https://f.test", "font-src", policy)).toBe(true);
  });

  it("treats an origin the policy does not grant as not covered", () => {
    expect(originGranted("https://evil.test", "script-src", policy)).toBe(
      false,
    );
    expect(originGranted("https://f.test", "script-src", policy)).toBe(false);
  });

  it("honors wildcard host and scheme-wide sources", () => {
    expect(originGranted("https://a.cdn.test", "style-src", policy)).toBe(true);
    expect(originGranted("https://anything.test", "connect-src", policy)).toBe(
      true,
    );
  });

  it("does not let a wildcard match the bare apex domain", () => {
    expect(originGranted("https://cdn.test", "style-src", policy)).toBe(false);
  });

  it("falls back to default-src when the directive is absent", () => {
    const fallbackPolicy = parseCsp("default-src https://f.test");
    expect(originGranted("https://f.test", "img-src", fallbackPolicy)).toBe(
      true,
    );
    expect(originGranted("https://other.test", "img-src", fallbackPolicy)).toBe(
      false,
    );
  });

  it("matches a schemeless CSP host-source", () => {
    const schemeless = parseCsp("font-src cdn.example.com");
    expect(
      originGranted("https://cdn.example.com", "font-src", schemeless),
    ).toBe(true);
  });

  it("never grants an unsupported preload destination", () => {
    expect(
      originGranted("https://f.test", UNSUPPORTED_PRELOAD_DIRECTIVE, policy),
    ).toBe(false);
  });
});

describe("CSP header extraction", () => {
  it("reads a single-line value case-insensitively", () => {
    expect(
      extractCspHeader(`content-security-policy = "default-src 'self'"`),
    ).toBe("default-src 'self'");
  });

  it("throws when no CSP header is present", () => {
    expect(() => extractCspHeader(`X-Frame-Options = "DENY"`)).toThrow(
      /Missing Content-Security-Policy/,
    );
  });

  it("throws when the CSP value is empty", () => {
    expect(() => extractCspHeader(`Content-Security-Policy = ""`)).toThrow(
      /empty/,
    );
  });
});

// Proves the two checks actually fail on drift, so the live-config assertions below are
// meaningful even while config.head currently loads nothing external.
describe("cross-check functions catch drift", () => {
  it("reports a head origin the CSP does not grant", () => {
    const head: HeadConfig[] = [
      ["script", { src: "https://cdn.evil.test/x.js" }],
    ];
    expect(uncoveredHeadOrigins(head, parseCsp("default-src 'self'"))).toEqual([
      "script[src] https://cdn.evil.test needs script-src",
    ]);
  });

  it("reports a CSP origin no head entry backs", () => {
    expect(
      unbackedCspOrigins([], parseCsp("img-src https://cdn.test")),
    ).toEqual(["https://cdn.test"]);
  });

  it("passes a head origin the CSP grants", () => {
    const head: HeadConfig[] = [
      ["link", { rel: "stylesheet", href: "https://styles.test/a.css" }],
    ];
    expect(
      uncoveredHeadOrigins(head, parseCsp("style-src https://styles.test")),
    ).toEqual([]);
  });
});

describe("CSP and config head origin cross-check", () => {
  it("loads its head config, so the checks below run against real data", () => {
    expect((config.head ?? []).length).toBeGreaterThan(0);
  });

  it("grants every external origin the head loads in the matching CSP directive", () => {
    expect(uncoveredHeadOrigins(config.head ?? [], cspDirectives)).toEqual([]);
  });

  it("references every external CSP origin from a head entry", () => {
    expect(unbackedCspOrigins(config.head ?? [], cspDirectives)).toEqual([]);
  });

  it("still grants each documented exempt origin, so the allowlist retires itself", () => {
    const grantedOrigins = new Set(cspOrigins);
    for (const exempt of CSP_ORIGINS_WITHOUT_HEAD_ENTRY) {
      const message = `${exempt} is no longer granted by the CSP — remove it from CSP_ORIGINS_WITHOUT_HEAD_ENTRY`;
      expect(grantedOrigins.has(exempt), message).toBe(true);
    }
  });
});
