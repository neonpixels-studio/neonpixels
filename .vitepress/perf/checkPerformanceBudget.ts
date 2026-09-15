import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// CI runs lint, typecheck, tests and build, but nothing budgets real page
// performance despite the font-preload/self-hosted-font/immutable-cache work
// sunk into keeping the hero fast (see ../fonts/writeFontPreloadLink and
// ../csp/writeReportOnlyHeaders). This script closes that gap by measuring
// the real build output — never hand-summed numbers that could drift from
// what actually ships — against two bounded budgets:
//
// 1. Critical-path assets: every stylesheet, modulepreload chunk, the entry
//    module script, and the preloaded critical font — everything a
//    first-time visitor's browser must fetch before the hero can paint and
//    become interactive. Catches a bloated dependency or a newly
//    render-blocking asset as a byte-count regression.
// 2. Images: a per-file cap, so one unoptimized image (a dropped-in
//    screenshot, an unresized export) fails loud instead of quietly
//    shipping. Per-file rather than aggregate so adding a few legitimate
//    small icons over time can't slowly erode the budget.
//
// Run standalone after `npm run build` (see package.json's perf:budget
// script and .github/workflows/ci.yml), against the real .vitepress/dist —
// not part of the vitest suite, which exercises the pure logic below against
// fixtures instead of paying for a full VitePress build.
//
// Executed with plain `node` against this .ts file directly (no ts-node/tsx):
// native type-stripping needs >=22.6 behind a flag or >=23.6 unflagged, and
// the `import.meta.main` entrypoint guard below needs >=22.18/24.2 (guarded
// explicitly — see that comment). CI reads its Node version from .nvmrc
// (currently 24.16.0), well past both floors — if .nvmrc is ever pinned
// below 23.6, add `--experimental-strip-types` to the perf:budget script in
// package.json.

// Resolved against the working directory rather than this module's own
// location: every npm script in this project (build, test, lint) assumes
// it's invoked from the repo root, and this one is no different — see the
// perf:budget script in package.json and the CI step in
// .github/workflows/ci.yml.
const DEFAULT_OUT_DIR = resolve(process.cwd(), ".vitepress/dist");
const INDEX_HTML_FILE = "index.html";

// Current build sits at ~156 KB (28.9 KB CSS + ~114.6 KB JS + 13.2 KB font);
// budgeted with room to grow deliberately, not enough to silently absorb a
// bloated dependency or a new render-blocking asset.
const CRITICAL_ASSET_BUDGET_BYTES = 240 * 1024;

// The current largest built image is the 1200x630 OG/Twitter card at
// ~238 KB; budgeted with headroom for a deliberate re-export, not a
// multi-times regression from an unoptimized drop-in.
const MAX_IMAGE_BYTES = 300 * 1024;

const PRELOAD_REL_SUBSTRING = "preload";
const MODULE_SCRIPT_TYPE = "module";
// Matches a URI with an explicit scheme ("https:", "data:", "blob:", ...) or a
// protocol-relative one ("//"). None of these points at a file this build
// emits, so all are excluded from the critical-asset scrape rather than
// mis-joined onto outDir.
const NON_LOCAL_HREF_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  // Formats an unconverted design export is most likely to arrive as —
  // exactly the "unoptimized drop-in" this budget exists to catch.
  ".bmp",
  ".tiff",
  ".tif",
]);

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    MISSING_PATH_CODES.has((error as { code?: string }).code ?? "")
  );
}

// Shared by every fs call in this module that should turn "path doesn't
// exist" into an actionable message (run the build first / the referenced
// asset is missing) while letting any other error (permissions, etc.)
// propagate as-is.
function rethrowMissingPath(error: unknown, message: string): never {
  if (isMissingPathError(error)) {
    throw new Error(message, { cause: error });
  }
  throw error;
}

function extractTags(html: string, tagName: string) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "g");
  return html.match(tagPattern) ?? [];
}

// Accepts both quote styles: VitePress's own output is consistently
// double-quoted, but a hand-written test fixture or a future template change
// using single quotes shouldn't silently drop the attribute from the match.
function extractAttribute(tag: string, attributeName: string) {
  const attributePattern = new RegExp(
    `\\b${attributeName}=(?:"([^"]*)"|'([^']*)')`,
  );
  const match = tag.match(attributePattern);
  return match?.[1] ?? match?.[2];
}

// Strips a trailing query string and/or fragment so two tags pointing at the
// same file with different cache-busting params (or a bare "#fragment")
// dedupe to one on-disk asset instead of two, one of which would fail to stat.
function stripQueryAndFragment(href: string) {
  const splitIndex = href.search(/[?#]/);
  if (splitIndex === -1) {
    return href;
  }
  return href.slice(0, splitIndex);
}

function isLocalHref(href: string | undefined): href is string {
  if (!href) {
    return false;
  }
  return !NON_LOCAL_HREF_PATTERN.test(href);
}

interface CriticalAssetHrefsBySource {
  preloadLinkHrefs: string[];
  moduleScriptSrcs: string[];
}

// Every <link> whose rel includes "preload" — plain preload (the font link),
// "preload stylesheet" (VitePress's stylesheet tag), and "modulepreload"
// (chunk hints) all match that substring — plus the entry
// `<script type="module">`. Together these are exactly the requests a
// browser issues before first paint/interactivity; everything else in
// <head> (icons, canonical, manifest) is deliberately excluded. A
// cross-origin or protocol-relative href (e.g. a third-party font CDN) is
// filtered out here rather than mis-resolved onto outDir — this budget can
// only measure bytes this build actually emits.
//
// Kept as two separate lists (rather than merged) so
// `assertFoundExpectedAssetTypes` can require each *source* — preload links
// vs. the entry module script — to have produced something: a modulepreload
// chunk and the entry module script are both ".js", so an extension-only
// check across a merged list can't tell "the entry script tag disappeared"
// from "the entry script tag is still there". Within `preloadLinkHrefs`
// itself, that same assertion further requires a stylesheet, a font, and a
// modulepreload chunk by extension, since a stylesheet link alone would
// otherwise mask, say, the font preload silently disappearing.
function extractCriticalAssetHrefs(html: string): CriticalAssetHrefsBySource {
  const preloadLinkHrefs = extractTags(html, "link")
    .filter((tag) =>
      (extractAttribute(tag, "rel") ?? "").includes(PRELOAD_REL_SUBSTRING),
    )
    .map((tag) => extractAttribute(tag, "href"))
    .filter(isLocalHref)
    .map(stripQueryAndFragment);

  const moduleScriptSrcs = extractTags(html, "script")
    .filter((tag) => extractAttribute(tag, "type") === MODULE_SCRIPT_TYPE)
    .map((tag) => extractAttribute(tag, "src"))
    .filter(isLocalHref)
    .map(stripQueryAndFragment);

  return { preloadLinkHrefs, moduleScriptSrcs };
}

function dedupeHrefs(hrefsBySource: CriticalAssetHrefsBySource) {
  return Array.from(
    new Set([
      ...hrefsBySource.preloadLinkHrefs,
      ...hrefsBySource.moduleScriptSrcs,
    ]),
  );
}

const STYLESHEET_EXTENSION = ".css";
const FONT_EXTENSION = ".woff2";
const SCRIPT_EXTENSION = ".js";

// Guards against the scrape silently finding nothing — or finding *less* than
// it should — in each of the three categories this budget exists to cover:
// the stylesheet, the critical font preload (the actual subject of the
// font-preload/self-hosted-font work this issue calls out), and at least one
// modulepreload chunk, plus the entry module script. Checking `preloadLinkHrefs`
// only for non-emptiness isn't enough: the stylesheet link alone keeps that
// list non-empty even if `writeFontPreloadLink` regresses and stops emitting
// the font `<link>` — exactly the case where this budget most needs to fail
// loud, since a build missing its font preload also reports a *lower* byte
// total, i.e. a real regression scored as an improvement. A future markup
// shape change (different `rel`, a dynamic-import bootstrap instead of a
// top-level `<script type="module">`) drops one of these to zero, which is
// what every check below is watching for.
function assertFoundExpectedAssetTypes(
  hrefsBySource: CriticalAssetHrefsBySource,
) {
  const missing: string[] = [];
  if (
    !hrefsBySource.preloadLinkHrefs.some((href) =>
      href.endsWith(STYLESHEET_EXTENSION),
    )
  ) {
    missing.push(`a preloaded stylesheet (*${STYLESHEET_EXTENSION})`);
  }
  if (
    !hrefsBySource.preloadLinkHrefs.some((href) =>
      href.endsWith(FONT_EXTENSION),
    )
  ) {
    missing.push(`a preloaded critical font (*${FONT_EXTENSION})`);
  }
  if (
    !hrefsBySource.preloadLinkHrefs.some((href) =>
      href.endsWith(SCRIPT_EXTENSION),
    )
  ) {
    missing.push("a modulepreload chunk (*.js)");
  }
  if (
    !hrefsBySource.moduleScriptSrcs.some((href) =>
      href.endsWith(SCRIPT_EXTENSION),
    )
  ) {
    missing.push('an entry <script type="module">');
  }
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `Performance budget: parsed ${INDEX_HTML_FILE} but is missing ${missing.join(", ")}; the preload/modulepreload markup shape likely changed`,
  );
}

// Assumes the site is served from the domain root (VitePress `site.base`,
// hardcoded to "/" in .vitepress/config.ts and never overridden here). If
// `base` is ever set to a subpath, every emitted href gains that prefix and
// every lookup below fails loud with "has no built file at" on an otherwise
// good build — a maintenance trap worth knowing about, not a live bug.
function hrefToDistPath(outDir: string, href: string) {
  const relativePath = href.startsWith("/") ? href.slice(1) : href;
  return join(outDir, relativePath);
}

function readIndexHtml(outDir: string) {
  const indexHtmlPath = join(outDir, INDEX_HTML_FILE);
  try {
    return readFileSync(indexHtmlPath, "utf8");
  } catch (error) {
    rethrowMissingPath(
      error,
      `Performance budget: no ${INDEX_HTML_FILE} at ${indexHtmlPath}; run \`npm run build\` first`,
    );
  }
}

function statSizeOrThrow(filePath: string, description: string) {
  try {
    return statSync(filePath).size;
  } catch (error) {
    rethrowMissingPath(
      error,
      `Performance budget: ${description} has no built file at ${filePath}`,
    );
  }
}

export interface CriticalAssetFile {
  href: string;
  bytes: number;
}

export interface CriticalAssetBudgetResult {
  totalBytes: number;
  budgetBytes: number;
  withinBudget: boolean;
  files: CriticalAssetFile[];
}

export function evaluateCriticalAssetBudget(
  outDir: string,
  budgetBytes: number = CRITICAL_ASSET_BUDGET_BYTES,
): CriticalAssetBudgetResult {
  const html = readIndexHtml(outDir);
  const hrefsBySource = extractCriticalAssetHrefs(html);
  assertFoundExpectedAssetTypes(hrefsBySource);
  const hrefs = dedupeHrefs(hrefsBySource);
  const files = hrefs.map((href) => ({
    href,
    bytes: statSizeOrThrow(
      hrefToDistPath(outDir, href),
      `critical asset "${href}" referenced from ${INDEX_HTML_FILE}`,
    ),
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    totalBytes,
    budgetBytes,
    withinBudget: totalBytes <= budgetBytes,
    files,
  };
}

function listFilesRecursively(directoryPath: string): string[] {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap(
    (entry) => {
      const entryPath = join(directoryPath, entry.name);
      return entry.isDirectory()
        ? listFilesRecursively(entryPath)
        : [entryPath];
    },
  );
}

export interface ImageBudgetViolation {
  path: string;
  bytes: number;
}

export interface ImageBudgetResult {
  budgetBytes: number;
  violations: ImageBudgetViolation[];
  withinBudget: boolean;
}

// Walks the whole build output rather than just outDir/images: a page-body
// image referenced from markdown or a component goes through Vite's asset
// pipeline and lands content-hashed under outDir/assets, never under
// outDir/images (which holds only the static files copied straight from
// public/images — favicons, manifest icons, the OG card). Filtering by
// extension instead of location is what actually catches an unoptimized
// image dropped in anywhere in the built site.
export function evaluateImageBudget(
  outDir: string,
  budgetBytes: number = MAX_IMAGE_BYTES,
): ImageBudgetResult {
  let allFiles: string[];
  try {
    allFiles = listFilesRecursively(outDir);
  } catch (error) {
    rethrowMissingPath(
      error,
      `Performance budget: no build output at ${outDir}; run \`npm run build\` first`,
    );
  }
  const imageFiles = allFiles.filter((path) =>
    IMAGE_EXTENSIONS.has(extname(path).toLowerCase()),
  );
  const violations = imageFiles
    .map((path) => ({
      path,
      bytes: statSizeOrThrow(path, "image discovered during the build scan"),
    }))
    .filter((file) => file.bytes > budgetBytes);
  return { budgetBytes, violations, withinBudget: violations.length === 0 };
}

export interface PerformanceBudgetResult {
  criticalAssets: CriticalAssetBudgetResult;
  images: ImageBudgetResult;
  passed: boolean;
}

export function evaluatePerformanceBudget(
  outDir: string,
): PerformanceBudgetResult {
  const criticalAssets = evaluateCriticalAssetBudget(outDir);
  const images = evaluateImageBudget(outDir);
  return {
    criticalAssets,
    images,
    passed: criticalAssets.withinBudget && images.withinBudget,
  };
}

function formatKb(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function printCriticalAssetReport(result: CriticalAssetBudgetResult) {
  const status = result.withinBudget ? "PASS" : "FAIL";
  console.log(
    `[perf-budget] critical assets: ${formatKb(result.totalBytes)} / ${formatKb(result.budgetBytes)} budget — ${status}`,
  );
  for (const file of result.files) {
    console.log(`  ${formatKb(file.bytes)}  ${file.href}`);
  }
}

function printImageReport(result: ImageBudgetResult) {
  if (result.withinBudget) {
    console.log(
      `[perf-budget] images: all files under ${formatKb(result.budgetBytes)} per-file budget — PASS`,
    );
    return;
  }
  console.log(
    `[perf-budget] images: ${result.violations.length} file(s) over ${formatKb(result.budgetBytes)} per-file budget — FAIL`,
  );
  for (const violation of result.violations) {
    console.log(`  ${formatKb(violation.bytes)}  ${violation.path}`);
  }
}

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

// Exported separately from main() so a test can assert on the exit code a
// pass/fail build produces without spawning a real `node` subprocess.
export function runPerformanceBudgetCli(outDir: string): number {
  const result = evaluatePerformanceBudget(outDir);
  printCriticalAssetReport(result.criticalAssets);
  printImageReport(result.images);
  if (!result.passed) {
    console.error(
      "[perf-budget] performance budget exceeded — see failures above",
    );
    return EXIT_FAILURE;
  }
  console.log("[perf-budget] within budget");
  return EXIT_SUCCESS;
}

function main() {
  try {
    process.exitCode = runPerformanceBudgetCli(DEFAULT_OUT_DIR);
  } catch (error) {
    console.error(
      "[perf-budget]",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = EXIT_FAILURE;
  }
}

// Only run when invoked directly (`npm run perf:budget` / `node
// checkPerformanceBudget.ts`), not when imported by the vitest suite.
// `import.meta.main` (Node >=22.18/24.2 — not to be confused with the lower
// floor for type-stripping above) compares resolved real paths under the
// hood — unlike a hand-rolled `process.argv[1] === fileURLToPath(import.meta.url)`
// check, it isn't fooled by a symlink anywhere in the invocation path (e.g.
// macOS's /tmp -> /private/tmp), which would otherwise make this script a
// silent no-op that still exits 0.
//
// On a Node below that floor `import.meta.main` is `undefined` rather than
// `false`, which would make this same `if` silently skip main() forever —
// exactly the failure mode this guard exists to avoid. Fail loud instead of
// reproducing it: .nvmrc (24.16.0) is comfortably past the floor today, so
// this only trips if that pin ever regresses.
if (import.meta.main === undefined) {
  throw new Error(
    "Performance budget: import.meta.main is unavailable on this Node version " +
      "(requires >=22.18 or >=24.2); the entrypoint guard cannot run",
  );
}
if (import.meta.main) {
  main();
}
