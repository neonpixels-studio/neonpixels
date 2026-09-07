import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Build-time glue: after the build emits its content-hashed assets, locates the
// self-hosted Archivo 900 face (the above-the-fold hero/404 wordmark font, see
// theme/index.ts) and injects a <link rel="preload"> for it into every emitted
// HTML document's <head>. Runs from VitePress's buildEnd hook — the same
// pattern as ../csp/writeReportOnlyHeaders — so the href always matches the
// real, content-hashed filename Vite emitted for this build rather than a
// hand-hardcoded hash that would drift on the next @fontsource bump.

const ASSETS_DIR_NAME = "assets";
const HTML_EXTENSION = ".html";
const HEAD_CLOSE_TAG = "</head>";
// @fontsource keeps this basename stable across package versions; only the
// content-hash segment Vite stamps in (between the name and the extension)
// changes from build to build.
const CRITICAL_FONT_FILENAME_PATTERN =
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

async function findCriticalFontAsset(outDir: string) {
  const assetsDir = join(outDir, ASSETS_DIR_NAME);
  const entries = await readdir(assetsDir, { withFileTypes: true });
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
  return entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(HTML_EXTENSION),
  );
}

function preloadLinkTag(href: string) {
  return `<link rel="preload" href="${href}" as="font" type="${FONT_MIME_TYPE}" crossorigin ${GENERATED_MARKER_ATTRIBUTE}>`;
}

function injectPreloadLink(html: string, linkTag: string) {
  const withoutPreviousLink = html.replace(GENERATED_LINK_PATTERN, "");
  const closeIndex = withoutPreviousLink.indexOf(HEAD_CLOSE_TAG);
  if (closeIndex === -1) {
    throw new Error("Font preload: built HTML has no closing </head> tag");
  }
  return (
    withoutPreviousLink.slice(0, closeIndex) +
    linkTag +
    withoutPreviousLink.slice(closeIndex)
  );
}

export async function writeFontPreloadLink(outDir: string) {
  const fontFilename = await findCriticalFontAsset(outDir);
  const linkTag = preloadLinkTag(`/${ASSETS_DIR_NAME}/${fontFilename}`);
  const htmlFiles = await readHtmlFiles(outDir);
  await Promise.all(
    htmlFiles.map(async (entry) => {
      // `parentPath` (Node 20.12+/21.4+) is guaranteed: .nvmrc pins Node 24,
      // same as ../csp/writeReportOnlyHeaders.
      const filePath = join(entry.parentPath, entry.name);
      const html = await readFile(filePath, "utf8");
      await writeFile(filePath, injectPreloadLink(html, linkTag), "utf8");
    }),
  );
}
