import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateCriticalAssetBudget,
  evaluateImageBudget,
  evaluatePerformanceBudget,
  runPerformanceBudgetCli,
} from "../../perf/checkPerformanceBudget";

let workDir = "";
let outDir = "";

function writeIndexHtml(contents: string) {
  writeFileSync(join(outDir, "index.html"), contents);
}

// Writes a fixture file at a path relative to outDir (e.g. "assets/app.js",
// "images/favicon.svg"), creating any intermediate directories. Named for
// where it lands rather than "asset"/"image" so the call site reads
// literally as the on-disk layout instead of requiring the reader to trace
// "../" segments back to the real path.
function writeDistFile(relativePath: string, byteLength: number) {
  const filePath = join(outDir, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, Buffer.alloc(byteLength, "a"));
}

// A trimmed-down but representative <head>: one preload-stylesheet link (the
// VitePress rel value), one modulepreload chunk, one plain preload (the
// critical font), one entry module script, and a handful of non-preload tags
// (icon/canonical/manifest) that a naive "every <link>" sum would wrongly
// include.
function buildHtml({
  extraHead = "",
}: {
  extraHead?: string;
} = {}) {
  return `<html><head>
  <link rel="preload stylesheet" href="/assets/style.css" as="style">
  <link rel="modulepreload" href="/assets/chunks/theme.js">
  <link rel="preload" href="/assets/font.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="icon" href="/images/favicon.svg">
  <link rel="canonical" href="https://example.test">
  <link rel="manifest" href="/images/site.webmanifest">
  <script type="module" src="/assets/app.js"></script>
  <script id="check-dark-mode">/* not a module */</script>
  ${extraHead}
  </head><body></body></html>`;
}

function writeFullCriticalAssets(byteLength = 100) {
  writeDistFile("assets/style.css", byteLength);
  writeDistFile("assets/chunks/theme.js", byteLength);
  writeDistFile("assets/font.woff2", byteLength);
  writeDistFile("assets/app.js", byteLength);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "neonpixels-perf-budget-"));
  outDir = join(workDir, "dist");
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("evaluateCriticalAssetBudget", () => {
  it("sums only preload/modulepreload links and the module script, ignoring icon/canonical/manifest links and non-module scripts", () => {
    writeDistFile("assets/style.css", 1000);
    writeDistFile("assets/chunks/theme.js", 2000);
    writeDistFile("assets/font.woff2", 500);
    writeDistFile("assets/app.js", 250);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    expect(result.totalBytes).toBe(1000 + 2000 + 500 + 250);
    expect(result.files.map((file) => file.href).sort()).toEqual(
      [
        "/assets/style.css",
        "/assets/chunks/theme.js",
        "/assets/font.woff2",
        "/assets/app.js",
      ].sort(),
    );
  });

  it("passes when the critical asset total is within budget", () => {
    writeFullCriticalAssets(1000);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 5000);

    expect(result.withinBudget).toBe(true);
  });

  it("passes when the critical asset total sits exactly on the budget boundary", () => {
    writeFullCriticalAssets(1250);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 5000);

    expect(result.totalBytes).toBe(5000);
    expect(result.withinBudget).toBe(true);
  });

  it("fails when the critical asset total exceeds budget", () => {
    writeFullCriticalAssets(3000);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 5000);

    expect(result.withinBudget).toBe(false);
    expect(result.totalBytes).toBeGreaterThan(result.budgetBytes);
  });

  it("dedupes an href referenced by more than one tag", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(
      buildHtml({
        extraHead: `<link rel="modulepreload" href="/assets/app.js">`,
      }),
    );

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    const appJsEntries = result.files.filter(
      (file) => file.href === "/assets/app.js",
    );
    expect(appJsEntries).toHaveLength(1);
  });

  it("dedupes the same file referenced with two different cache-busting query strings", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(
      buildHtml({
        extraHead: `<link rel="modulepreload" href="/assets/app.js?v=2">`,
      }),
    );

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    const appJsEntries = result.files.filter(
      (file) => file.href === "/assets/app.js",
    );
    expect(appJsEntries).toHaveLength(1);
  });

  it("dedupes the same file referenced with a fragment instead of a query string", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(
      buildHtml({
        extraHead: `<link rel="modulepreload" href="/assets/app.js#x">`,
      }),
    );

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    const appJsEntries = result.files.filter(
      (file) => file.href === "/assets/app.js",
    );
    expect(appJsEntries).toHaveLength(1);
  });

  it("matches single-quoted attributes the same as double-quoted ones", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(
      buildHtml({
        extraHead: `<link rel='modulepreload' href='/assets/app.js?single-quoted'>`,
      }),
    );

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    const appJsEntries = result.files.filter(
      (file) => file.href === "/assets/app.js",
    );
    expect(appJsEntries).toHaveLength(1);
  });

  it("ignores a cross-origin, protocol-relative, or data: preload instead of mis-resolving it onto outDir", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(
      buildHtml({
        extraHead: `
          <link rel="preload" href="https://fonts.example.com/font.woff2" as="font">
          <link rel="preload" href="//cdn.example.com/font.woff2" as="font">
          <link rel="preload" href="data:font/woff2;base64,AAAA" as="font">
        `,
      }),
    );

    const result = evaluateCriticalAssetBudget(outDir, 10_000);

    expect(
      result.files.some(
        (file) =>
          file.href.includes("example.com") || file.href.startsWith("data:"),
      ),
    ).toBe(false);
  });

  it("throws a descriptive error when a referenced critical asset is missing from the build output", () => {
    // style.css, theme.js and font.woff2 are written; app.js is not.
    writeDistFile("assets/style.css", 100);
    writeDistFile("assets/chunks/theme.js", 100);
    writeDistFile("assets/font.woff2", 100);
    writeIndexHtml(buildHtml());

    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /no built file at/,
    );
  });

  it("throws a descriptive error when index.html is missing", () => {
    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /run `npm run build` first/,
    );
  });

  it("throws instead of silently scoring zero when no preload link is found", () => {
    // Plain rel="stylesheet" (no "preload") — the shape a VitePress upgrade
    // or config change could produce.
    writeIndexHtml(
      `<html><head>
        <link rel="stylesheet" href="/assets/style.css">
        <script type="module" src="/assets/app.js"></script>
      </head><body></body></html>`,
    );

    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /markup shape likely changed/,
    );
  });

  it("throws instead of silently undercounting when the entry module script disappears but modulepreload chunks remain", () => {
    // Both the modulepreload chunk and a real entry script are ".js", so an
    // extension-only check can't tell these apart — this is exactly the
    // regression assertFoundExpectedAssetTypes exists to catch.
    writeIndexHtml(
      `<html><head>
        <link rel="preload stylesheet" href="/assets/style.css" as="style">
        <link rel="modulepreload" href="/assets/chunks/theme.js">
      </head><body></body></html>`,
    );

    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /markup shape likely changed/,
    );
  });

  it("throws instead of silently scoring a lower (seemingly better) total when the font preload disappears", () => {
    // A stylesheet link alone keeps preloadLinkHrefs non-empty, so a
    // source-level "is the list empty" check would miss exactly this
    // regression: writeFontPreloadLink stops emitting the font <link>, the
    // build genuinely gets slower (font discovered late, after CSS parse),
    // and a naive check would report a *lower*, passing byte total.
    writeIndexHtml(
      `<html><head>
        <link rel="preload stylesheet" href="/assets/style.css" as="style">
        <link rel="modulepreload" href="/assets/chunks/theme.js">
        <script type="module" src="/assets/app.js"></script>
      </head><body></body></html>`,
    );

    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /markup shape likely changed/,
    );
  });

  it("throws instead of silently undercounting when the modulepreload chunk hint disappears", () => {
    writeIndexHtml(
      `<html><head>
        <link rel="preload stylesheet" href="/assets/style.css" as="style">
        <link rel="preload" href="/assets/font.woff2" as="font" type="font/woff2" crossorigin>
        <script type="module" src="/assets/app.js"></script>
      </head><body></body></html>`,
    );

    expect(() => evaluateCriticalAssetBudget(outDir)).toThrow(
      /markup shape likely changed/,
    );
  });
});

describe("evaluateImageBudget", () => {
  it("passes when every image is under the per-file budget", () => {
    writeDistFile("images/favicon.svg", 300);
    writeDistFile("images/social-card.png", 900);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.withinBudget).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes when an image sits exactly on the per-file budget boundary", () => {
    writeDistFile("images/favicon.svg", 1000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.withinBudget).toBe(true);
  });

  it("flags any image over the per-file budget", () => {
    writeDistFile("images/favicon.svg", 300);
    writeDistFile("images/unoptimized-screenshot.png", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.withinBudget).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].path).toContain("unoptimized-screenshot.png");
  });

  it("checks images in nested directories too", () => {
    writeDistFile("images/nested/big.png", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.violations).toHaveLength(1);
  });

  it("catches an oversized image content-hashed under assets/, not just static files under images/", () => {
    // This is the real path most page-body images take: Vite's asset
    // pipeline hashes them into assets/, while images/ holds only the
    // static files copied straight from public/images (favicons, manifest
    // icons, the OG card).
    writeDistFile("assets/hero.DaBcDeFg.png", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].path).toContain("hero.DaBcDeFg.png");
  });

  it("ignores non-image files regardless of size", () => {
    writeDistFile("assets/framework.js", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.violations).toEqual([]);
  });

  it("catches an unconverted bmp/tiff export, not just web-ready formats", () => {
    // Formats an unresized design export is most likely to arrive as before
    // anyone converts it to something web-ready.
    writeDistFile("images/screenshot.bmp", 5000);
    writeDistFile("images/scan.tiff", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.violations).toHaveLength(2);
  });

  it("throws a descriptive error when the build output dir itself is missing", () => {
    rmSync(outDir, { recursive: true, force: true });

    expect(() => evaluateImageBudget(outDir)).toThrow(
      /run `npm run build` first/,
    );
  });
});

describe("evaluatePerformanceBudget", () => {
  it("passes only when both the critical asset and image budgets pass", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(buildHtml());
    writeDistFile("images/favicon.svg", 100);

    const result = evaluatePerformanceBudget(outDir);

    expect(result.passed).toBe(true);
    expect(result.criticalAssets.withinBudget).toBe(true);
    expect(result.images.withinBudget).toBe(true);
  });

  it("fails overall when only the image budget is exceeded", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(buildHtml());
    writeDistFile("images/unoptimized.png", 10 * 1024 * 1024);

    const result = evaluatePerformanceBudget(outDir);

    expect(result.passed).toBe(false);
    expect(result.criticalAssets.withinBudget).toBe(true);
    expect(result.images.withinBudget).toBe(false);
  });

  it("fails overall when only the critical asset budget is exceeded", () => {
    // 4 files x 70 KB = 280 KB, over the default 240 KB critical-asset budget;
    // 100 bytes is well under the default 300 KB per-image budget.
    writeFullCriticalAssets(70 * 1024);
    writeIndexHtml(buildHtml());
    writeDistFile("images/favicon.svg", 100);

    const result = evaluatePerformanceBudget(outDir);

    expect(result.passed).toBe(false);
    expect(result.criticalAssets.withinBudget).toBe(false);
    expect(result.images.withinBudget).toBe(true);
  });
});

describe("runPerformanceBudgetCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exit code 0 and logs a pass when the build is within budget", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(buildHtml());
    writeDistFile("images/favicon.svg", 100);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = runPerformanceBudgetCli(outDir);

    expect(exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("[perf-budget] within budget");
  });

  it("returns exit code 1 and logs the failure when the build exceeds budget", () => {
    writeFullCriticalAssets(100);
    writeIndexHtml(buildHtml());
    writeDistFile("images/unoptimized.png", 10 * 1024 * 1024);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = runPerformanceBudgetCli(outDir);

    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[perf-budget] performance budget exceeded — see failures above",
    );
  });
});
