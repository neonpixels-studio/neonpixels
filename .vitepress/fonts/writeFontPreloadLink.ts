import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Build-time glue: after the build emits its content-hashed assets, locates the
// self-hosted Archivo 900 face (the above-the-fold hero/404 wordmark font, see
// theme/index.ts) and injects a <link rel="preload"> for it into every emitted
// HTML document's <head>. Runs from VitePress's buildEnd hook — the same
// pattern as ../csp/writeReportOnlyHeaders — so the href always matches the
// real, content-hashed filename Vite emitted for this build rather than a
// hand-hardcoded hash that would drift on the next @fontsource bump.

// Vite's default assets subdirectory name; config.ts doesn't override it, but
// the real value still comes from siteConfig.assetsDir (see writeFontPreloadLink
// below) rather than this constant, so a future override can't silently 404 the
// preload while the CSS keeps loading the font from the real path.
const DEFAULT_ASSETS_DIR_NAME = "assets";
const HTML_EXTENSION = ".html";
const HEAD_CLOSE_TAG = "</head>";
// @fontsource keeps this basename stable across package versions; only the
// content-hash segment Vite stamps in (between the name and the extension)
// changes from build to build. Exported so tests assert against this exact
// pattern instead of hand-copying a second, driftable regex.
export const CRITICAL_FONT_FILENAME_PATTERN =
  /^archivo-latin-900-normal\.[A-Za-z0-9_-]+\.woff2$/;
const FONT_MIME_TYPE = "font/woff2";
// Marks the tag this script owns, so a second call against the same build
// output (e.g. a rebuild that reuses an un-emptied outDir) replaces its own
// previous link instead of stacking a duplicate with a stale hash.
const GENERATED_MARKER_ATTRIBUTE = 'data-generated="font-preload"';
const GENERATED_LINK_PATTERN = new RegExp(
  `\\s*<link\\b[^>]*${GENERATED_MARKER_ATTRIBUTE}[^>]*>`,
  "g",
);
const FILE_NOT_FOUND_CODE = "ENOENT";
// VitePress always normalizes `site.base` to a leading-and-trailing slash
// (defaults to "/"), so every emitted absolute URL — including this href —
// must be prefixed with it, not a hardcoded root.
const DEFAULT_SITE_BASE = "/";

function isFileNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === FILE_NOT_FOUND_CODE
  );
}

async function findCriticalFontAsset(outDir: string, assetsDirName: string) {
  const assetsDir = join(outDir, assetsDirName);
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new Error(
        `Font preload: build output has no ${assetsDirName}/ dir at ${assetsDir}; is this a complete VitePress build?`,
        { cause: error },
      );
    }
    throw error;
  }
  const matches = entries.filter(
    (entry) =>
      entry.isFile() && CRITICAL_FONT_FILENAME_PATTERN.test(entry.name),
  );
  if (matches.length === 0) {
    throw new Error(
      `Font preload: no built asset matching ${CRITICAL_FONT_FILENAME_PATTERN} found in ${assetsDir}; is the Archivo 900 face still self-hosted via @fontsource?`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Font preload: ${matches.length} assets matched ${CRITICAL_FONT_FILENAME_PATTERN} in ${assetsDir}; expected exactly one`,
    );
  }
  return matches[0].name;
}

async function readHtmlFiles(outDir: string) {
  const entries = await readdir(outDir, {
    recursive: true,
    withFileTypes: true,
  });
  const htmlFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(HTML_EXTENSION),
  );
  if (htmlFiles.length === 0) {
    throw new Error(
      `Font preload: no ${HTML_EXTENSION} documents found in ${outDir}; refusing to report success without injecting the preload`,
    );
  }
  return htmlFiles;
}

function preloadLinkTag(href: string) {
  return `<link rel="preload" href="${href}" as="font" type="${FONT_MIME_TYPE}" crossorigin ${GENERATED_MARKER_ATTRIBUTE}>`;
}

function injectPreloadLink(html: string, linkTag: string, filePath: string) {
  const withoutPreviousLink = html.replace(GENERATED_LINK_PATTERN, "");
  const closeIndex = withoutPreviousLink.indexOf(HEAD_CLOSE_TAG);
  if (closeIndex === -1) {
    throw new Error(`Font preload: ${filePath} has no closing </head> tag`);
  }
  return (
    withoutPreviousLink.slice(0, closeIndex) +
    linkTag +
    withoutPreviousLink.slice(closeIndex)
  );
}

export async function writeFontPreloadLink(
  outDir: string,
  siteBase: string = DEFAULT_SITE_BASE,
  assetsDirName: string = DEFAULT_ASSETS_DIR_NAME,
) {
  const fontFilename = await findCriticalFontAsset(outDir, assetsDirName);
  const linkTag = preloadLinkTag(`${siteBase}${assetsDirName}/${fontFilename}`);
  const htmlFiles = await readHtmlFiles(outDir);
  await Promise.all(
    htmlFiles.map(async (entry) => {
      // `parentPath` (Node 20.12+/21.4+) is guaranteed: .nvmrc pins Node 24,
      // same as ../csp/writeReportOnlyHeaders.
      const filePath = join(entry.parentPath, entry.name);
      const html = await readFile(filePath, "utf8");
      await writeFile(
        filePath,
        injectPreloadLink(html, linkTag, filePath),
        "utf8",
      );
    }),
  );
}
