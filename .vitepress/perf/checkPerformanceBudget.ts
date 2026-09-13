import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// Resolved against the working directory rather than this module's own
// location: every npm script in this project (build, test, lint) assumes
// it's invoked from the repo root, and this one is no different — see the
// perf:budget script in package.json and the CI step in
// .github/workflows/ci.yml.
const DEFAULT_OUT_DIR = resolve(process.cwd(), ".vitepress/dist");
const INDEX_HTML_FILE = "index.html";
const IMAGES_DIR_NAME = "images";

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

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    MISSING_PATH_CODES.has((error as { code?: string }).code ?? "")
  );
}

function extractTags(html: string, tagName: string) {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "g");
  return html.match(tagPattern) ?? [];
}

function extractAttribute(tag: string, attributeName: string) {
  const attributePattern = new RegExp(`\\b${attributeName}="([^"]*)"`);
  const match = tag.match(attributePattern);
  return match?.[1];
}

function stripQueryString(href: string) {
  const queryIndex = href.indexOf("?");
  if (queryIndex === -1) {
    return href;
  }
  return href.slice(0, queryIndex);
}

function isDefinedHref(href: string | undefined): href is string {
  return Boolean(href);
}

// Every <link> whose rel includes "preload" — plain preload (the font link),
// "preload stylesheet" (VitePress's stylesheet tag), and "modulepreload"
// (chunk hints) all match that substring — plus the entry
// `<script type="module">`. Together these are exactly the requests a
// browser issues before first paint/interactivity; everything else in
// <head> (icons, canonical, manifest) is deliberately excluded.
function extractCriticalAssetHrefs(html: string) {
  const preloadLinkHrefs = extractTags(html, "link")
    .filter((tag) =>
      (extractAttribute(tag, "rel") ?? "").includes(PRELOAD_REL_SUBSTRING),
    )
    .map((tag) => extractAttribute(tag, "href"));

  const moduleScriptSrcs = extractTags(html, "script")
    .filter((tag) => extractAttribute(tag, "type") === MODULE_SCRIPT_TYPE)
    .map((tag) => extractAttribute(tag, "src"));

  const hrefs = [...preloadLinkHrefs, ...moduleScriptSrcs]
    .filter(isDefinedHref)
    .map(stripQueryString);
  return Array.from(new Set(hrefs));
}

function hrefToDistPath(outDir: string, href: string) {
  const relativePath = href.startsWith("/") ? href.slice(1) : href;
  return join(outDir, relativePath);
}

function readIndexHtml(outDir: string) {
  const indexHtmlPath = join(outDir, INDEX_HTML_FILE);
  try {
    return readFileSync(indexHtmlPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Performance budget: no ${INDEX_HTML_FILE} at ${indexHtmlPath}; run \`npm run build\` first`,
        { cause: error },
      );
    }
    throw error;
  }
}

function statSizeOrThrow(filePath: string, href: string) {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Performance budget: critical asset "${href}" referenced from ${INDEX_HTML_FILE} has no built file at ${filePath}`,
        { cause: error },
      );
    }
    throw error;
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
  const hrefs = extractCriticalAssetHrefs(html);
  const files = hrefs.map((href) => ({
    href,
    bytes: statSizeOrThrow(hrefToDistPath(outDir, href), href),
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
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const filePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...listFilesRecursively(entryPath));
      continue;
    }
    filePaths.push(entryPath);
  }
  return filePaths;
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

export function evaluateImageBudget(
  outDir: string,
  budgetBytes: number = MAX_IMAGE_BYTES,
): ImageBudgetResult {
  const imagesDir = join(outDir, IMAGES_DIR_NAME);
  let imageFiles: string[];
  try {
    imageFiles = listFilesRecursively(imagesDir);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `Performance budget: no ${IMAGES_DIR_NAME}/ dir at ${imagesDir}; run \`npm run build\` first`,
        { cause: error },
      );
    }
    throw error;
  }
  const violations = imageFiles
    .map((path) => ({ path, bytes: statSync(path).size }))
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

function main() {
  const result = evaluatePerformanceBudget(DEFAULT_OUT_DIR);
  printCriticalAssetReport(result.criticalAssets);
  printImageReport(result.images);
  if (!result.passed) {
    console.error(
      "[perf-budget] performance budget exceeded — see failures above",
    );
    process.exitCode = 1;
    return;
  }
  console.log("[perf-budget] within budget");
}

// Only run when invoked directly (`npm run perf:budget` / `node
// checkPerformanceBudget.ts`), not when imported by the vitest suite.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
