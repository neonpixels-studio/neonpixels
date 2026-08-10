import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import config from "../config";
import type { HeadConfig } from "vitepress";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const THEME_STYLE_PATH = resolve(process.cwd(), ".vitepress/theme/style.css");

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

  it("imports no remote stylesheet in the theme CSS", () => {
    const themeCss = readFileSync(THEME_STYLE_PATH, "utf8");
    const remoteImports =
      themeCss.match(/@import\s+(?:url\()?\s*["']?https?:\/\/[^"')]+/gi) ?? [];
    expect(remoteImports).toEqual([]);
  });
});
