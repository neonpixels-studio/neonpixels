// @vitest-environment node
// The build runs a real server-side render; happy-dom's stubbed network layer
// otherwise logs ECONNREFUSED noise during it, so this file uses Node.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vitepress";

// Asserts the tags survive `vitepress build` into the emitted HTML, not just the
// config.head array. config.test.ts already covers the config object; this closes
// the gap where a dropped head entry could green CI while shipping a page missing
// its structured data, canonical, or social metadata.

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Cold vitepress build runs well over vitest's default 5s ceiling.
const BUILD_TIMEOUT_MS = 120_000;

const HEAD_CLOSE_TAG = "</head>";
const INDEX_HTML_FILE = "index.html";
const HEADERS_FILE = "_headers";
const NETLIFY_CONFIG_FILE = "netlify.toml";
const REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";
const REPORT_ONLY_HEADER_LINE = new RegExp(
  `^\\s*${REPORT_ONLY_HEADER_NAME}:\\s*(.+)$`,
  "m",
);
const SHA256_SCRIPT_SOURCE = /'sha256-[A-Za-z0-9+/]+=*'/;
const ENFORCING_SCRIPT_SRC = "script-src 'self' 'unsafe-inline'";
// The last artifact vitepress writes; it flushes after build() resolves, so we
// wait on it before cleanup to avoid an unhandled ENOENT racing the dir removal.
const SITEMAP_FILE = "sitemap.xml";
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_POLL_MS = 50;
const HTTPS_PROTOCOL = "https:";

const JSON_LD_BLOCK_PATTERN =
  /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

const SCHEMA_ORG_CONTEXT = "https://schema.org";
const ORGANIZATION_TYPE = "Organization";

// Open Graph keys live on `property`, Twitter keys on `name`; matching the wrong
// attribute would let an og tag emitted as name="" (which crawlers ignore) pass.
const OG_ATTRIBUTE = "property";
const TWITTER_ATTRIBUTE = "name";

// [attribute, key] tags that must be present and non-empty in the built <head>.
// A dropped head entry removes its whole tag, so requiring each key is what makes
// a silent regression fail.
const REQUIRED_META: ReadonlyArray<readonly [string, string]> = [
  [OG_ATTRIBUTE, "og:type"],
  [OG_ATTRIBUTE, "og:url"],
  [OG_ATTRIBUTE, "og:title"],
  [OG_ATTRIBUTE, "og:description"],
  [OG_ATTRIBUTE, "og:image"],
  [TWITTER_ATTRIBUTE, "twitter:card"],
  [TWITTER_ATTRIBUTE, "twitter:title"],
  [TWITTER_ATTRIBUTE, "twitter:image"],
];

// Tags whose content must be an absolute https URL: crawlers reject a relative
// og:image/og:url/twitter:image, exactly what a base-URL refactor can produce.
const ABSOLUTE_URL_META: ReadonlyArray<readonly [string, string]> = [
  [OG_ATTRIBUTE, "og:url"],
  [OG_ATTRIBUTE, "og:image"],
  [TWITTER_ATTRIBUTE, "twitter:image"],
];

let buildOutDir = "";
let builtHead = "";
let generatedHeaders = "";

// The exact textContent of every executable inline script the build emitted:
// scripts with a src or a non-JS type (application/ld+json) are excluded, so
// this is the set the Report-Only script-src hashes must cover.
function executableInlineScriptBodies(html: string) {
  const bodies: string[] = [];
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) {
      continue;
    }
    if (/\btype\s*=\s*["']?application\/ld\+json/i.test(attributes)) {
      continue;
    }
    bodies.push(match[2]);
  }
  return bodies;
}

function reportOnlyHeaderValue(headersFile: string) {
  const match = headersFile.match(REPORT_ONLY_HEADER_LINE);
  return match ? match[1].trim() : null;
}

function extractHead(html: string) {
  const closeIndex = html.indexOf(HEAD_CLOSE_TAG);
  if (closeIndex === -1) {
    throw new Error("Built index.html has no closing </head> tag");
  }
  return html.slice(0, closeIndex);
}

// Anchored on start-or-whitespace so `name` doesn't also match `data-name` etc.
// The attribute name is always a hardcoded literal below, never rendered input.
function attributeValue(tag: string, attribute: string) {
  const match = tag.match(new RegExp(`(?:^|\\s)${attribute}="([^"]*)"`));
  return match ? match[1] : null;
}

// Steps over quoted values so a legal `>` inside an attribute can't truncate the tag.
function tagsNamed(head: string, tagName: string) {
  return head.match(new RegExp(`<${tagName}\\b(?:[^>"]|"[^"]*")*>`, "g")) ?? [];
}

// Matches by the identifying attribute first, then reads content independently, so
// attribute order never matters. Duplicate keys are themselves a bug worth failing.
function findUniqueTag(
  head: string,
  tagName: string,
  attribute: string,
  key: string,
) {
  const matches = tagsNamed(head, tagName).filter(
    (tag) => attributeValue(tag, attribute) === key,
  );
  if (matches.length > 1) {
    throw new Error(
      `Built <head> has ${matches.length} ${tagName} tags for ${key}`,
    );
  }
  return matches[0] ?? null;
}

function metaContent(head: string, attribute: string, key: string) {
  const tag = findUniqueTag(head, "meta", attribute, key);
  if (!tag) {
    return null;
  }
  return attributeValue(tag, "content");
}

function canonicalHref(head: string) {
  const tag = findUniqueTag(head, "link", "rel", "canonical");
  if (!tag) {
    return null;
  }
  return attributeValue(tag, "href");
}

function parseJsonLd(raw: string) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unparseable JSON-LD block in built <head>`, {
      cause: error,
    });
  }
}

// Parses every ld+json block and returns the Organization one, tolerating extra
// blocks rather than assuming the Organization renders first.
function organizationJsonLd(head: string) {
  const blocks = [...head.matchAll(JSON_LD_BLOCK_PATTERN)].map((match) =>
    parseJsonLd(match[1]),
  );
  if (!blocks.length) {
    throw new Error("Built <head> is missing a JSON-LD script block");
  }
  const organization = blocks.find(
    (block) => block["@type"] === ORGANIZATION_TYPE,
  );
  if (!organization) {
    throw new Error("No Organization JSON-LD block in built <head>");
  }
  return organization;
}

async function waitForBuildToSettle(outDir: string) {
  const sitemapPath = resolve(outDir, SITEMAP_FILE);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!existsSync(sitemapPath)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Build did not emit ${SITEMAP_FILE} within settle window`,
      );
    }
    await delay(SETTLE_POLL_MS);
  }
}

beforeAll(async () => {
  // Build into a throwaway dir so the suite never clobbers the real dist output.
  buildOutDir = mkdtempSync(join(tmpdir(), "neonpixels-build-html-"));
  await build(PROJECT_ROOT, { outDir: buildOutDir });
  await waitForBuildToSettle(buildOutDir);
  const indexHtml = readFileSync(resolve(buildOutDir, INDEX_HTML_FILE), "utf8");
  builtHead = extractHead(indexHtml);
  generatedHeaders = readFileSync(resolve(buildOutDir, HEADERS_FILE), "utf8");
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (buildOutDir) {
    rmSync(buildOutDir, { recursive: true, force: true });
  }
});

describe("built index.html head", () => {
  it("emits a canonical link with an absolute https href", () => {
    const href = canonicalHref(builtHead);
    expect(href, "canonical <link> missing from built HTML").not.toBeNull();
    expect(URL.canParse(href!), `canonical href not absolute: ${href}`).toBe(
      true,
    );
    expect(new URL(href!).protocol).toBe(HTTPS_PROTOCOL);
  });

  it("emits a parseable Organization JSON-LD block", () => {
    const structuredData = organizationJsonLd(builtHead);
    expect(structuredData["@context"]).toBe(SCHEMA_ORG_CONTEXT);
    expect(structuredData.url).toBeTruthy();
  });

  it.each(REQUIRED_META)("emits a non-empty %s=%s tag", (attribute, key) => {
    const content = metaContent(builtHead, attribute, key);
    expect(content, `${key} missing from built HTML`).not.toBeNull();
    expect(content!.trim().length).toBeGreaterThan(0);
  });

  it.each(ABSOLUTE_URL_META)(
    "emits %s=%s as an absolute https URL",
    (attribute, key) => {
      const content = metaContent(builtHead, attribute, key);
      expect(content, `${key} missing from built HTML`).not.toBeNull();
      expect(URL.canParse(content!), `${key} not absolute: ${content}`).toBe(
        true,
      );
      expect(new URL(content!).protocol).toBe(HTTPS_PROTOCOL);
    },
  );
});

describe("generated CSP Report-Only header", () => {
  it("emits a Content-Security-Policy-Report-Only header scoped to /*", () => {
    expect(generatedHeaders.split("\n")[0]).toBe("/*");
    expect(reportOnlyHeaderValue(generatedHeaders)).not.toBeNull();
  });

  it("carries a script-src of hashes with no 'unsafe-inline'", () => {
    const value = reportOnlyHeaderValue(generatedHeaders)!;
    const scriptSrc = value
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src"));
    expect(scriptSrc, "no script-src in Report-Only header").toBeTruthy();
    expect(scriptSrc).toMatch(SHA256_SCRIPT_SOURCE);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("hashes every executable inline script in the built index page", () => {
    const value = reportOnlyHeaderValue(generatedHeaders)!;
    const indexHtml = readFileSync(
      resolve(buildOutDir, INDEX_HTML_FILE),
      "utf8",
    );
    const bodies = executableInlineScriptBodies(indexHtml);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const digest = createHash("sha256").update(body, "utf8").digest("base64");
      expect(value).toContain(`'sha256-${digest}'`);
    }
  });

  it("leaves the enforcing CSP in netlify.toml unchanged (still 'unsafe-inline')", () => {
    const netlifyConfig = readFileSync(
      resolve(PROJECT_ROOT, NETLIFY_CONFIG_FILE),
      "utf8",
    );
    expect(netlifyConfig).toContain(ENFORCING_SCRIPT_SRC);
  });
});
