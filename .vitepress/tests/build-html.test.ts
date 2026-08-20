// @vitest-environment node
// The build runs a real server-side render; happy-dom's stubbed network layer
// otherwise logs ECONNREFUSED noise during it, so this file uses Node.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vitepress";

import { SMOKE_BUILD_REUSE_DIR_ENV } from "./utils/buildReuse";

// Asserts the tags survive `vitepress build` into the emitted HTML, not just the
// config.head array. config.test.ts already covers the config object; this closes
// the gap where a dropped head entry could green CI while shipping a page missing
// its structured data, canonical, or social metadata.

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Cold vitepress build runs well over vitest's default 5s ceiling.
const BUILD_TIMEOUT_MS = 120_000;

const HEAD_CLOSE_TAG = "</head>";
const INDEX_HTML_FILE = "index.html";
// When a prior `vitepress build` already produced dist output, reuse it instead
// of compiling a second time. The Netlify deploy sets this to the published dir
// so a deploy build compiles the site once; CI and local runs leave it unset and
// the suite builds its own throwaway copy, keeping the smoke check self-contained.
const REUSE_BUILD_DIR_ENV = SMOKE_BUILD_REUSE_DIR_ENV;
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
// Only a build the suite created itself is cleaned up; a reused deploy dir is left
// in place because it is the artifact Netlify publishes.
let ownsBuildDir = false;

// A complete vitepress build emits both the entry HTML and the sitemap (the last
// artifact it writes); requiring both rejects a wrong dir or a build still in
// flight, which an index.html-only check would accept.
function reuseDirIsComplete(reuseDir: string) {
  return (
    existsSync(resolve(reuseDir, INDEX_HTML_FILE)) &&
    existsSync(resolve(reuseDir, SITEMAP_FILE))
  );
}

// Returns the resolved reuse dir when the deploy pointed the suite at an existing
// build, or null when the suite should compile its own. Fails loud if the flag is
// set but the referenced build is missing or incomplete, rather than silently
// rebuilding or greening against a partial artifact.
function resolveReuseDir() {
  const rawValue = process.env[REUSE_BUILD_DIR_ENV];
  if (rawValue === undefined) {
    return null;
  }
  const configured = rawValue.trim();
  if (!configured) {
    throw new Error(
      `${REUSE_BUILD_DIR_ENV} is set but empty; unset it to build a fresh copy or point it at a complete build`,
    );
  }
  const reuseDir = resolve(PROJECT_ROOT, configured);
  if (reuseDirIsComplete(reuseDir)) {
    return reuseDir;
  }
  throw new Error(
    `${REUSE_BUILD_DIR_ENV}=${configured} but no complete build (${INDEX_HTML_FILE} + ${SITEMAP_FILE}) exists there`,
  );
}

async function prepareBuildDir() {
  const reuseDir = resolveReuseDir();
  if (reuseDir) {
    return reuseDir;
  }
  // Build into a throwaway dir so the suite never clobbers the real dist output.
  const freshDir = mkdtempSync(join(tmpdir(), "neonpixels-build-html-"));
  // Record ownership before building so afterAll still cleans up the temp tree
  // if build() or the settle wait throws partway through.
  buildOutDir = freshDir;
  ownsBuildDir = true;
  await build(PROJECT_ROOT, { outDir: freshDir });
  await waitForBuildToSettle(freshDir);
  return freshDir;
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
  buildOutDir = await prepareBuildDir();
  const indexHtml = readFileSync(resolve(buildOutDir, INDEX_HTML_FILE), "utf8");
  builtHead = extractHead(indexHtml);
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  if (buildOutDir && ownsBuildDir) {
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

// The deploy only compiles once when this resolution is honest: reuse a complete
// build, ignore the unset flag, and refuse an incomplete dir. CI never sets the
// flag, so without these cases the reuse path would first run in production.
describe("reuse-dir resolution", () => {
  const originalValue = process.env[REUSE_BUILD_DIR_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[REUSE_BUILD_DIR_ENV];
      return;
    }
    process.env[REUSE_BUILD_DIR_ENV] = originalValue;
  });

  it("returns null when the reuse flag is unset", () => {
    delete process.env[REUSE_BUILD_DIR_ENV];
    expect(resolveReuseDir()).toBeNull();
  });

  it("throws when the reuse flag is set but empty", () => {
    process.env[REUSE_BUILD_DIR_ENV] = "";
    expect(() => resolveReuseDir()).toThrow(REUSE_BUILD_DIR_ENV);
  });

  it("returns the resolved dir when it holds a complete build", () => {
    const completeDir = mkdtempSync(join(tmpdir(), "neonpixels-reuse-ok-"));
    writeFileSync(resolve(completeDir, INDEX_HTML_FILE), "<html></html>");
    writeFileSync(resolve(completeDir, SITEMAP_FILE), "<urlset/>");
    process.env[REUSE_BUILD_DIR_ENV] = completeDir;
    try {
      expect(resolveReuseDir()).toBe(completeDir);
    } finally {
      rmSync(completeDir, { recursive: true, force: true });
    }
  });

  // Production passes a relative value (`.vitepress/dist`); this proves it
  // anchors to the project root, not the shell's cwd, so vitest launched from a
  // subdirectory still resolves the same dist. The build lives under tmpdir (not
  // the repo tree) and is reached via a project-root-relative path.
  it("resolves a relative reuse dir against the project root", () => {
    const completeDir = mkdtempSync(join(tmpdir(), "neonpixels-reuse-rel-"));
    try {
      writeFileSync(resolve(completeDir, INDEX_HTML_FILE), "<html></html>");
      writeFileSync(resolve(completeDir, SITEMAP_FILE), "<urlset/>");
      process.env[REUSE_BUILD_DIR_ENV] = relative(PROJECT_ROOT, completeDir);
      expect(resolveReuseDir()).toBe(completeDir);
    } finally {
      rmSync(completeDir, { recursive: true, force: true });
    }
  });

  it("throws when the reuse flag points at an incomplete build", () => {
    const partialDir = mkdtempSync(join(tmpdir(), "neonpixels-reuse-bad-"));
    writeFileSync(resolve(partialDir, INDEX_HTML_FILE), "<html></html>");
    process.env[REUSE_BUILD_DIR_ENV] = partialDir;
    try {
      expect(() => resolveReuseDir()).toThrow(REUSE_BUILD_DIR_ENV);
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });
});
