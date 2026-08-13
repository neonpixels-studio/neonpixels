import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import config from "../config";
import type { HeadConfig } from "vitepress";

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

function findMetaContent(identifier: string) {
  const head = config.head ?? [];
  const entry = head.find(
    ([tag, attributes]) =>
      tag === "meta" &&
      (attributes?.property ?? attributes?.name) === identifier,
  );
  if (!entry) {
    throw new Error(`Missing meta tag for "${identifier}"`);
  }
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
