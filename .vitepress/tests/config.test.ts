import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import config, { buildOrganizationJsonLd } from "../config";
import { PROJECTS } from "@theme/data/projects";
import type { HeadConfig, SiteConfig } from "vitepress";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const THEME_STYLE_PATH = resolve(process.cwd(), ".vitepress/theme/style.css");
const THEME_DIR = resolve(process.cwd(), ".vitepress/theme");

// The exact self-hosted @fontsource imports the theme must load — one per font weight the
// UI actually renders, latin subset only (the site is lang=en-US):
//   Archivo 900              — every .font-display element is font-black (weight 900)
//   JetBrains Mono 400/500/700 — the body/mono face at default, font-medium, font-bold
// Pinned as an exact set (not merely "present") so BOTH regressions fail loudly: dropping
// a weight the UI uses, or re-introducing an unused weight/subset that bloats the bundle
// (the whole point of trimming — see .vitepress/theme/index.ts).
const EXPECTED_FONT_IMPORTS = [
  "@fontsource/archivo/latin-900.css",
  "@fontsource/jetbrains-mono/latin-400.css",
  "@fontsource/jetbrains-mono/latin-500.css",
  "@fontsource/jetbrains-mono/latin-700.css",
];

// Matches a @fontsource stylesheet reference, from either a JS side-effect import
// (`import "@fontsource/…"`) or a CSS `@import "…"` / `@import url("…")`, capturing the
// specifier. Comments are stripped before matching (below) so a disabled import isn't
// counted as loaded — which would leave the exact-set assertion green while the weight
// is actually gone.
const FONTSOURCE_REFERENCE_PATTERN =
  /(?:import\s+|@import\s+(?:url\(\s*)?)["'](@fontsource\/[^"']+)["']/g;

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function collectFontsourceReferences(source: string) {
  return [...stripComments(source).matchAll(FONTSOURCE_REFERENCE_PATTERN)].map(
    (match) => match[1],
  );
}

// Theme source files that could pull in a font (JS/TS imports, Vue SFCs, CSS @imports).
const THEME_SOURCE_EXTENSIONS = new Set([".ts", ".vue", ".css"]);

function collectThemeSourceFiles() {
  return readdirSync(THEME_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => THEME_SOURCE_EXTENSIONS.has(extname(entry)))
    .map((entry) => resolve(THEME_DIR, entry));
}

function readThemeVueSources() {
  return collectThemeSourceFiles()
    .filter((filePath) => extname(filePath) === ".vue")
    .map((filePath) => readFileSync(filePath, "utf8"));
}

// Tailwind font-weight utilities the trimmed bundle can render as a real @font-face:
// Archivo ships only 900 (font-black); JetBrains Mono ships 400 (default, no class),
// 500 (font-medium) and 700 (font-bold). Any other weight utility would render a faux
// weight from a face we no longer bundle — silently, with no fallback or warning.
const SUPPORTED_WEIGHT_UTILITIES = new Set([
  "font-medium",
  "font-bold",
  "font-black",
]);
const WEIGHT_UTILITY_PATTERN =
  /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g;

// Quoted class lists in a Vue SFC: `class="…"`/`:class="…"` attributes and the script-side
// string constants (e.g. BADGE_BASE) that feed them. Non-global so `.test()` stays stateless.
const QUOTED_CLASS_LIST_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`/g;
const DISPLAY_UTILITY_PATTERN = /\bfont-display\b/;
const BLACK_UTILITY_PATTERN = /\bfont-black\b/;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const IHDR_TYPE_OFFSET = 12;
const PNG_CHUNK_TYPE_LENGTH = 4;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_MIN_BYTES = 24;

// Base used only to resolve root-relative asset paths; ignored for absolute URLs.
const URL_RESOLUTION_BASE = "https://example.test";
const RESOLUTION_ORIGIN = new URL(URL_RESOLUTION_BASE).origin;

// The site's own origin, so absolute self-hosted hrefs count as local, not remote.
// Computed once; a schemeless or malformed hostname falls back rather than crashing collection.
const SITE_ORIGIN = (() => {
  const hostname = config.sitemap?.hostname;
  if (!hostname) {
    return RESOLUTION_ORIGIN;
  }
  const withScheme = hostname.includes("://")
    ? hostname
    : `https://${hostname}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return RESOLUTION_ORIGIN;
  }
})();

// rel tokens naming a page URL, not an on-disk asset — skipped when walking link hrefs.
// A denylist so any future asset-bearing rel is verified by default. `alternate` is
// handled separately: it names a page only when it carries hreflang (a feed link does not).
const PAGE_LINK_RELS = new Set(["canonical", "prev", "next"]);

// rel tokens whose link fetches a subresource — pointed at a remote origin, each is
// a third-party request. Guards against re-introducing a Google Fonts stylesheet or
// preconnect after the fonts were self-hosted (.vitepress/theme/index.ts).
const RESOURCE_FETCHING_RELS = new Set([
  "stylesheet",
  "preconnect",
  "dns-prefetch",
  "prefetch",
  "preload",
  "modulepreload",
  "icon",
]);

const MIN_IMAGE_ALT_LENGTH = 20;
// X (Twitter) truncates image alt text beyond this many characters.
const MAX_IMAGE_ALT_LENGTH = 420;

function readPngDimensions(filePath: string) {
  const buffer = readFileSync(filePath);
  if (buffer.length < PNG_HEADER_MIN_BYTES) {
    throw new Error(`${filePath} is truncated (${buffer.length} bytes)`);
  }
  const hasSignature = buffer
    .subarray(0, PNG_SIGNATURE.length)
    .equals(PNG_SIGNATURE);
  if (!hasSignature) {
    throw new Error(`${filePath} is not a PNG (bad signature)`);
  }
  const chunkType = buffer.toString(
    "ascii",
    IHDR_TYPE_OFFSET,
    IHDR_TYPE_OFFSET + PNG_CHUNK_TYPE_LENGTH,
  );
  if (chunkType !== "IHDR") {
    throw new Error(`${filePath} has no leading IHDR chunk`);
  }
  return {
    width: buffer.readUInt32BE(PNG_WIDTH_OFFSET),
    height: buffer.readUInt32BE(PNG_HEIGHT_OFFSET),
  };
}

const JSON_LD_SCRIPT_TYPE = "application/ld+json";

// Shared by every "find the one head tag matching a predicate" lookup below
// (a JSON-LD script tag, a named meta tag) so each caller stays a one-liner
// over a single throw-if-missing implementation.
function findHeadEntry(
  predicate: (_headConfigEntry: HeadConfig) => boolean,
  description: string,
) {
  const head = config.head ?? [];
  const entry = head.find(predicate);
  if (!entry) {
    throw new Error(`Missing head entry: ${description}`);
  }
  return entry;
}

function findJsonLdScript() {
  const entry = findHeadEntry(
    ([tag, attributes]) =>
      tag === "script" && attributes?.type === JSON_LD_SCRIPT_TYPE,
    `<script type="${JSON_LD_SCRIPT_TYPE}">`,
  );
  if (entry.length !== 3) {
    throw new Error("ld+json script has no body to parse");
  }
  return JSON.parse(entry[2]);
}

function findMetaContent(identifier: string) {
  const entry = findHeadEntry(
    ([tag, attributes]) =>
      tag === "meta" &&
      (attributes?.property ?? attributes?.name) === identifier,
    `meta tag for "${identifier}"`,
  );
  const content = entry[1].content;
  if (content === undefined) {
    throw new Error(`Meta tag "${identifier}" has no content attribute`);
  }
  return content;
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function publicPathForUrl(assetUrl: string) {
  const pathname = decodePathname(
    new URL(assetUrl, URL_RESOLUTION_BASE).pathname,
  ).replace(/^\//, "");
  return resolve(PUBLIC_DIR, pathname);
}

function resolveMetaImagePath(identifier: string) {
  return publicPathForUrl(findMetaContent(identifier));
}

// Confirms the path is a real file AND that its case matches disk, since macOS (APFS)
// is case-insensitive but the deployed Linux host is not — a case mismatch 404s in prod.
function isRealFileWithExactCase(filePath: string) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    return false;
  }
  return readdirSync(dirname(filePath)).includes(basename(filePath));
}

function isLocalHref(href: string) {
  try {
    const { origin } = new URL(href, URL_RESOLUTION_BASE);
    return origin === RESOLUTION_ORIGIN || origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

function relTokensFor(attributes: Record<string, string> | undefined) {
  return (attributes?.rel ?? "").toLowerCase().trim().split(/\s+/);
}

function isPageLinkRel(attributes: Record<string, string> | undefined) {
  const tokens = relTokensFor(attributes);
  if (tokens.includes("alternate")) {
    return Boolean(attributes?.hreflang);
  }
  return tokens.some((token) => PAGE_LINK_RELS.has(token));
}

function isRemoteResourceFetchingLink(entry: HeadConfig) {
  const [tag, attributes] = entry;
  if (tag !== "link") {
    return false;
  }
  const fetchesResource = relTokensFor(attributes).some((token) =>
    RESOURCE_FETCHING_RELS.has(token),
  );
  if (!fetchesResource) {
    return false;
  }
  const href = attributes?.href;
  return typeof href === "string" && !isLocalHref(href);
}

function collectLocalAssetHrefs() {
  const head = config.head ?? [];
  const hrefs = head
    .filter(([tag, attributes]) => tag === "link" && !isPageLinkRel(attributes))
    .map(([, attributes]) => attributes?.href)
    .filter((href): href is string => typeof href === "string")
    .filter(isLocalHref);
  return [...new Set(hrefs)];
}

describe("Open Graph image metadata", () => {
  it("declares dimensions that match the real og:image file", () => {
    const { width, height } = readPngDimensions(
      resolveMetaImagePath("og:image"),
    );
    expect(findMetaContent("og:image:width")).toBe(String(width));
    expect(findMetaContent("og:image:height")).toBe(String(height));
  });

  it("points twitter:image at the same asset as og:image", () => {
    expect(findMetaContent("twitter:image")).toBe(findMetaContent("og:image"));
  });

  it("declares usable alt text for og:image and twitter:image", () => {
    const altText = findMetaContent("og:image:alt");
    expect(altText.trim().length).toBeGreaterThanOrEqual(MIN_IMAGE_ALT_LENGTH);
    expect(altText.trim().length).toBeLessThanOrEqual(MAX_IMAGE_ALT_LENGTH);
    expect(altText).not.toBe(findMetaContent("og:title"));
    expect(altText).not.toBe(findMetaContent("og:description"));
    expect(findMetaContent("twitter:image:alt")).toBe(altText);
  });
});

describe("Local head asset hrefs", () => {
  const localHrefs = collectLocalAssetHrefs();

  it("declares at least one local head href to verify", () => {
    expect(localHrefs.length).toBeGreaterThan(0);
  });

  it.each(localHrefs)("resolves %s to a real file under public", (href) => {
    expect(isRealFileWithExactCase(publicPathForUrl(href)), href).toBe(true);
  });
});

// Fonts are self-hosted and bundled by Vite (.vitepress/theme/index.ts). Guard both
// surfaces that could re-introduce a render-blocking third-party font request: a
// remote resource link in config.head, and a remote @import in the theme stylesheet.
describe("No render-blocking third-party font requests", () => {
  const head = config.head ?? [];
  const remoteResourceLinks = head.filter(isRemoteResourceFetchingLink);

  it("declares no resource-fetching head link to a remote origin", () => {
    const remoteHrefs = remoteResourceLinks.map(
      ([, attributes]) => attributes?.href,
    );
    expect(remoteHrefs).toEqual([]);
  });

  it("references no remote URL in the theme CSS", () => {
    const themeCss = readFileSync(THEME_STYLE_PATH, "utf8");
    // Any @import or url() pointing off-origin (including scheme-relative //) is a
    // third-party fetch — the surface a self-hosted Google Fonts regression uses.
    const remoteReferences =
      themeCss.match(/(?:@import\s*|url\(\s*)["']?(?:https?:)?\/\//gi) ?? [];
    expect(remoteReferences).toEqual([]);
  });
});

// The fonts were trimmed to only the weights/subsets the UI renders (issue #17). These
// tests pin the invariant from both directions: the loaded @fontsource set is exactly the
// used weights (latin subset only), and the markup never asks for a weight that set can't
// render. Together they fail loudly if either side drifts — an unused import creeps back,
// or an element adopts a weight with no bundled @font-face.
describe("Self-hosted fonts are trimmed to the weights actually used", () => {
  const loadedFontReferences = collectThemeSourceFiles().flatMap((filePath) =>
    collectFontsourceReferences(readFileSync(filePath, "utf8")),
  );

  it("loads exactly the used weights across the theme, latin subset only", () => {
    expect([...new Set(loadedFontReferences)].sort()).toEqual(
      [...EXPECTED_FONT_IMPORTS].sort(),
    );
  });

  it("uses no font-weight utility the trimmed bundle can't render", () => {
    const usedWeightUtilities = new Set(
      readThemeVueSources().join("\n").match(WEIGHT_UTILITY_PATTERN) ?? [],
    );
    const unsupported = [...usedWeightUtilities].filter(
      (utility) => !SUPPORTED_WEIGHT_UTILITIES.has(utility),
    );
    expect(unsupported).toEqual([]);
  });

  // Archivo (font-display) is bundled only at weight 900, so every class list opting into
  // the display face must also be font-black; any other pairing renders a faux Archivo
  // weight. Checked per quoted class list (template class attrs and script class constants
  // alike), not per source line, so it holds when Prettier wraps a long class attribute.
  it("pairs every font-display class list with font-black", () => {
    const unpairedDisplayClassLists = readThemeVueSources()
      .flatMap((source) => source.match(QUOTED_CLASS_LIST_PATTERN) ?? [])
      .filter((classList) => DISPLAY_UTILITY_PATTERN.test(classList))
      .filter((classList) => !BLACK_UTILITY_PATTERN.test(classList));
    expect(unpairedDisplayClassLists).toEqual([]);
  });
});

// getNoindexHeaderLines and writeReportOnlyHeaders (folding the noindex line
// into the CSP writer's block, see .vitepress/robots and .vitepress/csp) are
// each tested in isolation, but nothing else asserts the buildEnd hook here
// actually wires one into the other — that seam is exactly where a silent
// regression (every deploy preview becoming indexable) could slip through
// with both halves' own tests still green. Runs buildEnd against a real,
// throwaway outDir with the real repo netlify.toml as the CSP source.
describe("buildEnd wires the noindex context into the generated _headers", () => {
  const HEADERS_FILE_NAME = "_headers";
  const NOINDEX_HEADER_LINE = "X-Robots-Tag: noindex";
  const INLINE_SCRIPT = `<script id="boot">boot()</script>`;
  // writeFontPreloadLink (now the first step buildEnd runs) requires a real
  // </head> to inject its <link rel="preload"> before, same as CSP hashing
  // only ever needs the inline script.
  const HTML_DOCUMENT = `<html><head>${INLINE_SCRIPT}</head><body></body></html>`;
  const ORIGINAL_CONTEXT = process.env.CONTEXT;
  // Matches CRITICAL_FONT_FILENAME_PATTERN in ../fonts/writeFontPreloadLink —
  // buildEnd now runs the font preload step first, so a fixture build output
  // needs a real asset to find or that step throws before the CSP step it's
  // actually testing here ever runs.
  const CRITICAL_FONT_FILENAME = "archivo-latin-900-normal.D5FQlLQC.woff2";
  const ASSETS_DIR_NAME = "assets";

  let outDir = "";

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "neonpixels-buildend-"));
    writeFileSync(join(outDir, "index.html"), HTML_DOCUMENT);
    const assetsDir = join(outDir, ASSETS_DIR_NAME);
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, CRITICAL_FONT_FILENAME), "");
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    if (ORIGINAL_CONTEXT === undefined) {
      delete process.env.CONTEXT;
      return;
    }
    process.env.CONTEXT = ORIGINAL_CONTEXT;
  });

  async function runBuildEnd() {
    const buildEnd = config.buildEnd as (
      _siteConfig: SiteConfig,
    ) => Promise<void>;
    await buildEnd({
      outDir,
      site: { base: "/" },
      assetsDir: ASSETS_DIR_NAME,
    } as unknown as SiteConfig);
    return readFileSync(join(outDir, HEADERS_FILE_NAME), "utf8");
  }

  it.each(["deploy-preview", "branch-deploy"])(
    "noindexes a %s build",
    async (context) => {
      process.env.CONTEXT = context;

      const headers = await runBuildEnd();

      // Indented, not just present: an unindented line in a Netlify
      // _headers file is parsed as a new path pattern rather than a header.
      expect(headers).toContain(`\n  ${NOINDEX_HEADER_LINE}\n`);
    },
  );

  it.each([
    ["production", "production"],
    ["an unset CONTEXT", undefined],
  ])("does not noindex %s", async (_label, context) => {
    if (context === undefined) {
      delete process.env.CONTEXT;
    } else {
      process.env.CONTEXT = context;
    }

    const headers = await runBuildEnd();

    expect(headers).not.toContain(NOINDEX_HEADER_LINE);
  });
});

// The org's ld+json exists to tell crawlers about the four projects it promotes
// (issue #83). Each project is a sibling WebSite node in a top-level @graph,
// tied to the Organization node by `publisher` — see the rationale in
// config.ts for why that shape was chosen over `sameAs`/`hasPart` (the
// properties named in the issue).
//
// `EXPECTED_PROJECT_URLS` below is a deliberate tripwire: a literal anchor on
// the four known domains, so adding a fifth project fails here and requires a
// hand edit — that's the point, not a gap. The grimicorn test further down is
// what actually catches a wrong field mapping (e.g. the bare project id
// instead of "name+tld"), since the id and name happen to match today.
//
// findJsonLdScript() is called fresh inside each `it`, never hoisted to the
// describe body — a missing or malformed script tag then fails only the test
// that reads it, instead of throwing during collection and skipping every
// other suite in this file (see collectLocalAssetHrefs()/findMetaContent()
// usage above for the same convention).
const EXPECTED_PROJECT_URLS = [
  "https://grimicorn.dev",
  "https://wanderist.io",
  "https://basin.fm",
  "https://markpost.io",
];

// jsonLd comes straight from JSON.parse via findJsonLdScript() — implicitly
// `any`, left untyped deliberately, since asserting on its exact shape is
// what every test below does.
function findGraphNodesByType(jsonLd: any, type: string) {
  return (jsonLd["@graph"] as Array<Record<string, unknown>>).filter(
    (node) => node["@type"] === type,
  );
}

describe("Organization JSON-LD links the four projects", () => {
  it("wraps the org and every project in a single @graph", () => {
    const jsonLd = findJsonLdScript();
    expect(Array.isArray(jsonLd["@graph"])).toBe(true);
    expect(jsonLd["@graph"].length).toBe(1 + PROJECTS.length);
  });

  it("declares exactly one Organization node", () => {
    const organizationNodes = findGraphNodesByType(
      findJsonLdScript(),
      "Organization",
    );
    expect(organizationNodes).toHaveLength(1);
    expect(organizationNodes[0].name).toBe("Neon Pixels");
  });

  it("declares the four known project domains as WebSite nodes", () => {
    const projectNodes = findGraphNodesByType(findJsonLdScript(), "WebSite");
    expect(projectNodes.map((node) => node.url)).toEqual(EXPECTED_PROJECT_URLS);
  });

  it("links every WebSite node back to the Organization node's @id via publisher", () => {
    const jsonLd = findJsonLdScript();
    const [organizationNode] = findGraphNodesByType(jsonLd, "Organization");
    const projectNodes = findGraphNodesByType(jsonLd, "WebSite");
    for (const projectNode of projectNodes) {
      expect(projectNode.publisher).toEqual({
        "@id": organizationNode["@id"],
      });
    }
  });

  it("describes grimicorn.dev as a WebSite with its full domain and real description", () => {
    const grimicorn = PROJECTS.find((project) => project.id === "grimicorn");
    if (!grimicorn) {
      throw new Error(
        "PROJECTS is missing the grimicorn entry this fixture assumes",
      );
    }
    const projectNodes = findGraphNodesByType(findJsonLdScript(), "WebSite");
    expect(projectNodes).toContainEqual(
      expect.objectContaining({
        name: "grimicorn.dev",
        url: "https://grimicorn.dev",
        description: grimicorn.description,
      }),
    );
  });

  it("labels every WebSite node with name+tld, matching PROJECTS one-to-one", () => {
    const projectNodes = findGraphNodesByType(findJsonLdScript(), "WebSite");
    expect(
      projectNodes.map((node) => ({
        name: node.name,
        url: node.url,
        description: node.description,
      })),
    ).toEqual(
      PROJECTS.map((project) => ({
        name: `${project.name}${project.tld}`,
        url: project.url,
        description: project.description,
      })),
    );
  });

  // Exercises buildOrganizationJsonLd() directly with a hostile description,
  // rather than reading PROJECTS through findJsonLdScript() — nothing in the
  // real project data contains "<" today, so a check limited to the real
  // payload would pass even if the escaping in config.ts were deleted
  // entirely. Asserted on the raw string, not the parsed object: JSON.parse
  // silently undoes the escape, which would hide the exact regression this
  // test exists to catch.
  it("escapes '<' so a project description can't close the script tag early", () => {
    const hostileDescription = "</script><script>alert(1)</script>";
    const serialized = buildOrganizationJsonLd([
      {
        name: "evil",
        tld: ".test",
        url: "https://evil.test",
        description: hostileDescription,
      },
    ]);
    expect(serialized).not.toContain("</script>");
    expect(JSON.parse(serialized)["@graph"][1].description).toBe(
      hostileDescription,
    );
  });
});
