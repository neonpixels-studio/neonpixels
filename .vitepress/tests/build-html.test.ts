// @vitest-environment node
// The build runs a real server-side render; happy-dom's stubbed network layer
// otherwise logs ECONNREFUSED noise during it, so this file uses Node.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const HTML_EXTENSION = ".html";
const HEADERS_FILE = "_headers";
const NETLIFY_CONFIG_FILE = "netlify.toml";
const ASSETS_DIR = "assets";
// VitePress/Rollup stamp a base64url content hash segment (>= 8 chars, dot
// delimited) into every emitted asset filename, e.g. app.C3xK9-aQ.js or
// index.md.CdYTxh9z.lean.js. That hash is the property that makes /assets/*
// safe to cache immutably for a year, so match it anywhere in the name rather
// than only immediately before the final extension.
const CONTENT_HASH_FILENAME = /\.[A-Za-z0-9_-]{8,}\./;
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
// Only a build the suite created itself is cleaned up; a reused deploy dir is left
// in place because it is the artifact Netlify publishes.
let ownsBuildDir = false;
let generatedHeaders = "";

// A complete vitepress build emits the entry HTML, the sitemap (the last artifact
// it writes), and the generated _headers file; beforeAll reads all three, so
// requiring all three rejects a wrong dir or a build still in flight that an
// index.html-only check would accept, and keeps the reuse guard from letting a
// dir missing _headers through to a raw ENOENT.
const REQUIRED_BUILD_ARTIFACTS: readonly string[] = [
  INDEX_HTML_FILE,
  SITEMAP_FILE,
  HEADERS_FILE,
];

function reuseDirIsComplete(reuseDir: string) {
  return REQUIRED_BUILD_ARTIFACTS.every((artifact) =>
    existsSync(resolve(reuseDir, artifact)),
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
    `${REUSE_BUILD_DIR_ENV}=${configured} but no complete build (${REQUIRED_BUILD_ARTIFACTS.join(", ")}) exists there`,
  );
}

// Resolved once so the containment guard compares against a normalized absolute
// path. resolve() collapses `.`/`..` and trailing separators; it does not follow
// symlinks, but every dir this suite deletes is built from this same tmpdir()
// string, so the two sides can't disagree on a symlinked temp root.
const OS_TMPDIR = resolve(tmpdir());
// mkdtempSync stamps this onto every build dir the suite creates; cleanupBuildDir
// requires it, so the two can't drift and a foreign dir is never a delete target.
const BUILD_DIR_PREFIX = "neonpixels-build-html-";

// True only when `candidate` resolves to a path strictly inside the OS temp dir.
// Segment-aware: a sibling like `<tmpdir>..foo` yields a relative path starting
// `..` and is correctly rejected, while a real child is kept. The tmpdir root
// itself returns false.
function isWithinTmpdir(candidate: string) {
  if (!candidate) {
    return false;
  }
  const relativePath = relative(OS_TMPDIR, resolve(candidate));
  if (!relativePath) {
    return false;
  }
  if (relativePath === "..") {
    return false;
  }
  if (relativePath.startsWith(`..${sep}`)) {
    return false;
  }
  // An absolute relative-path only arises on Windows across drive letters; a
  // cross-volume path is outside the temp root.
  return !isAbsolute(relativePath);
}

// True only for a dir this suite created: inside the OS temp dir and carrying the
// build-dir prefix. This is the verifiable form of "we own it" — independent of
// the caller-passed flag — so a reused Netlify publish dir can never satisfy it.
function isOwnedBuildDir(dir: string) {
  if (!isWithinTmpdir(dir)) {
    return false;
  }
  return basename(resolve(dir)).startsWith(BUILD_DIR_PREFIX);
}

// Removes a build tree only when the caller claims ownership AND the dir is one
// this suite actually created. The structural check is the backstop that keeps a
// refactor which mislabels a reused deploy build as owned from ever rmSync-ing a
// real dist directory. Returns whether the guard allowed the delete (assertable
// without inspecting the filesystem), not whether a dir was physically present.
function cleanupBuildDir(dir: string, owned: boolean) {
  if (!owned) {
    return false;
  }
  if (!isOwnedBuildDir(dir)) {
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// Runs the guarded delete and fails loud if an owned dir survives it: that means
// the prefix/containment invariant drifted from what mkdtempSync stamped, leaking
// a temp tree. afterAll and the guard tests both drive this, so the loud path is
// covered rather than asserted by comment alone.
function finalizeBuildDir(dir: string, owned: boolean) {
  if (cleanupBuildDir(dir, owned)) {
    return;
  }
  if (!owned) {
    return;
  }
  throw new Error(`Owned build dir left in place by cleanup guard: ${dir}`);
}

// Returns the build dir plus whether the suite owns it (created it and may delete
// it) — an explicit value, not a hidden module-level side effect. A reused deploy
// build is not owned; a fresh throwaway dir is. It does not build: beforeAll
// records ownership from this return before awaiting the build, so a build that
// throws or times out still leaves afterAll able to clean an owned temp tree.
function resolveBuildDir() {
  const reuseDir = resolveReuseDir();
  if (reuseDir) {
    return { dir: reuseDir, owned: false };
  }
  // A throwaway dir under the same temp root the containment guard checks against,
  // so the suite never clobbers the real dist output.
  return { dir: mkdtempSync(join(OS_TMPDIR, BUILD_DIR_PREFIX)), owned: true };
}

// Compiles the site into an owned build dir, then waits for it to settle. Kept
// separate from resolveBuildDir so the external build tool sits behind its own
// seam and ownership is recorded before this await runs.
async function buildInto(outDir: string) {
  await build(PROJECT_ROOT, { outDir });
  await waitForBuildToSettle(outDir);
}

// Independent oracle: the exact textContent of every executable inline script the
// build emitted (scripts with a src or an application/ld+json type are excluded),
// so it is the set the Report-Only script-src hashes must cover. Quote-aware and
// whitespace-tolerant on the end tag so it is not strictly weaker than the code
// under test — a script the production extractor mishandles must still surface
// here rather than being skipped identically by both.
function executableInlineScriptBodies(html: string) {
  const bodies: string[] = [];
  for (const match of html.matchAll(
    /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const attributes = match[1];
    if (/(?:^|\s)src\s*=/i.test(attributes)) {
      continue;
    }
    if (/(?:^|\s)type\s*=\s*["']?application\/ld\+json/i.test(attributes)) {
      continue;
    }
    if (match[2].trim() === "") {
      continue;
    }
    bodies.push(match[2]);
  }
  return bodies;
}

function readAllBuiltHtml(outDir: string) {
  return readdirSync(outDir, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(HTML_EXTENSION))
    .map((name) => readFileSync(resolve(outDir, name as string), "utf8"));
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
  const prepared = resolveBuildDir();
  // Record ownership before the await so afterAll cleans the temp tree even if the
  // build below throws or the hook times out.
  buildOutDir = prepared.dir;
  ownsBuildDir = prepared.owned;
  if (prepared.owned) {
    await buildInto(buildOutDir);
  }
  const indexHtml = readFileSync(resolve(buildOutDir, INDEX_HTML_FILE), "utf8");
  builtHead = extractHead(indexHtml);
  generatedHeaders = readFileSync(resolve(buildOutDir, HEADERS_FILE), "utf8");
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  finalizeBuildDir(buildOutDir, ownsBuildDir);
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

// Creates a throwaway dir seeded with the given build artifacts, runs the
// assertion against it, and always removes the tree — even if a fixture write or
// the assertion throws. Centralizes the near-identical stub-build fixtures below
// so they can't drift or leak a temp dir on a mid-setup failure.
function withStubBuildDir(
  prefix: string,
  artifacts: readonly string[],
  assertion: (_dir: string) => void,
) {
  const dir = mkdtempSync(join(OS_TMPDIR, prefix));
  try {
    artifacts.forEach((artifact) => {
      writeFileSync(resolve(dir, artifact), "<stub/>");
    });
    assertion(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
    withStubBuildDir(
      "neonpixels-reuse-ok-",
      REQUIRED_BUILD_ARTIFACTS,
      (completeDir) => {
        process.env[REUSE_BUILD_DIR_ENV] = completeDir;
        expect(resolveReuseDir()).toBe(completeDir);
      },
    );
  });

  // Production passes a relative value (`.vitepress/dist`); this proves it
  // anchors to the project root, not the shell's cwd, so vitest launched from a
  // subdirectory still resolves the same dist. The build lives under tmpdir (not
  // the repo tree) and is reached via a project-root-relative path.
  it("resolves a relative reuse dir against the project root", () => {
    withStubBuildDir(
      "neonpixels-reuse-rel-",
      REQUIRED_BUILD_ARTIFACTS,
      (completeDir) => {
        process.env[REUSE_BUILD_DIR_ENV] = relative(PROJECT_ROOT, completeDir);
        expect(resolveReuseDir()).toBe(completeDir);
      },
    );
  });

  // Seeds every required artifact except _headers, so this also guards the
  // completeness check against dropping the _headers requirement that beforeAll
  // depends on.
  it("throws when the reuse flag points at an incomplete build", () => {
    withStubBuildDir(
      "neonpixels-reuse-bad-",
      [INDEX_HTML_FILE, SITEMAP_FILE],
      (partialDir) => {
        process.env[REUSE_BUILD_DIR_ENV] = partialDir;
        expect(() => resolveReuseDir()).toThrow(REUSE_BUILD_DIR_ENV);
      },
    );
  });

  // Not-owned is what keeps afterAll from deleting Netlify's publish dir.
  it("reports a reused build dir as not owned", () => {
    withStubBuildDir(
      "neonpixels-reuse-owned-",
      REQUIRED_BUILD_ARTIFACTS,
      (completeDir) => {
        process.env[REUSE_BUILD_DIR_ENV] = completeDir;
        expect(resolveBuildDir()).toEqual({ dir: completeDir, owned: false });
      },
    );
  });

  it("reports a fresh build dir as owned and guard-recognized", () => {
    delete process.env[REUSE_BUILD_DIR_ENV];
    const { dir, owned } = resolveBuildDir();
    try {
      expect(owned).toBe(true);
      expect(isOwnedBuildDir(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The delete in afterAll is a footgun: point buildOutDir at the Netlify publish
// dir and a naive rmSync wipes the deploy. These cases pin the guard so ownership
// is explicit and a non-tmpdir path is never removed, even when flagged owned.
describe("build-dir cleanup guard", () => {
  // Siblings of the temp root: outside it by construction, so these hold on any
  // machine regardless of where HOME or the repo tree live, and nothing is
  // created on disk. The prefixed one models a reused dist dir mislabeled owned.
  const OUTSIDE_TMPDIR = resolve(OS_TMPDIR, "..", "neonpixels-outside-tmp");
  const PREFIXED_OUTSIDE_TMPDIR = resolve(
    OS_TMPDIR,
    "..",
    `${BUILD_DIR_PREFIX}dist`,
  );

  it("treats a child of the OS tmpdir as contained", () => {
    withStubBuildDir(BUILD_DIR_PREFIX, [], (dir) => {
      expect(isWithinTmpdir(dir)).toBe(true);
    });
  });

  it("does not treat the OS tmpdir root itself as contained", () => {
    expect(isWithinTmpdir(tmpdir())).toBe(false);
  });

  // The most destructive input: the direct parent of tmpdir (e.g. /var/folders/ab
  // or `/`). Drop the `=== ".."` check and this is what the guard would rmSync.
  it("does not treat the parent of the OS tmpdir as contained", () => {
    expect(isWithinTmpdir(resolve(OS_TMPDIR, ".."))).toBe(false);
  });

  it("does not treat a path outside the OS tmpdir as contained", () => {
    expect(isWithinTmpdir(OUTSIDE_TMPDIR)).toBe(false);
  });

  // An empty path must not resolve to cwd (which can itself sit under tmpdir when
  // the suite runs from a temp checkout) and become deletable.
  it("treats an empty path as neither contained nor deletable", () => {
    expect(isWithinTmpdir("")).toBe(false);
    expect(cleanupBuildDir("", true)).toBe(false);
  });

  it("removes an owned build dir inside the OS tmpdir", () => {
    withStubBuildDir(BUILD_DIR_PREFIX, [], (dir) => {
      expect(cleanupBuildDir(dir, true)).toBe(true);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("leaves a build dir the caller does not own in place", () => {
    withStubBuildDir(BUILD_DIR_PREFIX, [], (dir) => {
      expect(cleanupBuildDir(dir, false)).toBe(false);
      expect(existsSync(dir)).toBe(true);
    });
  });

  // Prefix branch (as opposed to the containment branch tested next).
  it("never deletes a foreign dir even when the caller claims ownership", () => {
    withStubBuildDir("neonpixels-foreign-", [], (dir) => {
      expect(cleanupBuildDir(dir, true)).toBe(false);
      expect(existsSync(dir)).toBe(true);
    });
  });

  // Containment branch (the literal footgun): a build-prefixed path outside the
  // temp tree — the shape a reused Netlify publish dir takes — is never deleted
  // even when flagged owned. Drop the tmpdir check and only this case fails.
  it("never deletes a build-prefixed dir outside the OS tmpdir when owned", () => {
    expect(cleanupBuildDir(PREFIXED_OUTSIDE_TMPDIR, true)).toBe(false);
  });

  it("finalizes an owned build dir by removing it", () => {
    withStubBuildDir(BUILD_DIR_PREFIX, [], (dir) => {
      finalizeBuildDir(dir, true);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("does not throw when finalizing an unowned dir", () => {
    expect(() => finalizeBuildDir(OUTSIDE_TMPDIR, false)).not.toThrow();
  });

  it("throws loud when an owned dir escapes the cleanup guard", () => {
    expect(() => finalizeBuildDir(PREFIXED_OUTSIDE_TMPDIR, true)).toThrow(
      PREFIXED_OUTSIDE_TMPDIR,
    );
  });
});

describe("generated CSP Report-Only header", () => {
  it("emits a Content-Security-Policy-Report-Only header scoped to /*", () => {
    expect(generatedHeaders).toMatch(
      new RegExp(`^/\\*\\n\\s+${REPORT_ONLY_HEADER_NAME}:`, "m"),
    );
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

  it("hashes every executable inline script across all built pages", () => {
    const value = reportOnlyHeaderValue(generatedHeaders)!;
    const bodies = readAllBuiltHtml(buildOutDir).flatMap(
      executableInlineScriptBodies,
    );
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

describe("shipped immutable asset caching", () => {
  // Two-space indent is pinned literally: a blank line between the path and the
  // header terminates the rule block for Netlify, so `\s+` (which matches \n)
  // would green a malformed file that ships no Cache-Control at all.
  it("ships the hand-written /assets/* immutable Cache-Control rule", () => {
    expect(generatedHeaders).toMatch(
      /^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m,
    );
  });

  // The year-long immutable cache is only safe because every /assets/ file is
  // content-hashed, so its URL's bytes never change. If VitePress ever emitted an
  // un-hashed file there, this rule would pin a stale copy for a year — guard the
  // invariant the header depends on rather than trusting the comment.
  it("only ships content-hashed filenames under /assets/", () => {
    // Prove the matcher actually discriminates, so it can't silently rot into a
    // regex that greens on un-hashed names.
    expect("app.js").not.toMatch(CONTENT_HASH_FILENAME);
    expect("style.css").not.toMatch(CONTENT_HASH_FILENAME);
    expect("app.C3xK9-aQ.js").toMatch(CONTENT_HASH_FILENAME);

    const assetsDir = resolve(buildOutDir, ASSETS_DIR);
    const assetFiles = readdirSync(assetsDir, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    expect(assetFiles.length).toBeGreaterThan(0);
    for (const assetFile of assetFiles) {
      expect(assetFile.name).toMatch(CONTENT_HASH_FILENAME);
    }
  });

  // netlify.toml and _headers are merged, and for a header both set on overlapping
  // paths netlify.toml wins. A Cache-Control added to its /* block would silently
  // override this /assets/* rule while every _headers assertion still passed.
  it("does not let netlify.toml override the immutable asset cache", () => {
    const netlifyConfig = readFileSync(
      resolve(PROJECT_ROOT, NETLIFY_CONFIG_FILE),
      "utf8",
    );
    expect(netlifyConfig).not.toMatch(/Cache-Control/);
  });
});
