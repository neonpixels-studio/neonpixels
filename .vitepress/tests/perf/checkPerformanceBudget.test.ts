import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateCriticalAssetBudget,
  evaluateImageBudget,
  evaluatePerformanceBudget,
} from "../../perf/checkPerformanceBudget";

let workDir = "";
let outDir = "";
let assetsDir = "";
let imagesDir = "";

function writeIndexHtml(contents: string) {
  writeFileSync(join(outDir, "index.html"), contents);
}

function writeAsset(name: string, byteLength: number) {
  writeFileSync(join(assetsDir, name), Buffer.alloc(byteLength, "a"));
}

function writeImage(name: string, byteLength: number) {
  writeFileSync(join(imagesDir, name), Buffer.alloc(byteLength, "a"));
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "neonpixels-perf-budget-"));
  outDir = join(workDir, "dist");
  assetsDir = join(outDir, "assets", "chunks");
  imagesDir = join(outDir, "images");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(imagesDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("evaluateCriticalAssetBudget", () => {
  it("sums only preload/modulepreload links and the module script, ignoring icon/canonical/manifest links and non-module scripts", () => {
    writeAsset("../style.css", 1000);
    writeAsset("theme.js", 2000);
    writeAsset("../font.woff2", 500);
    writeAsset("../app.js", 250);
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
    writeAsset("../style.css", 1000);
    writeAsset("theme.js", 1000);
    writeAsset("../font.woff2", 1000);
    writeAsset("../app.js", 1000);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 5000);

    expect(result.withinBudget).toBe(true);
  });

  it("fails when the critical asset total exceeds budget", () => {
    writeAsset("../style.css", 3000);
    writeAsset("theme.js", 3000);
    writeAsset("../font.woff2", 3000);
    writeAsset("../app.js", 3000);
    writeIndexHtml(buildHtml());

    const result = evaluateCriticalAssetBudget(outDir, 5000);

    expect(result.withinBudget).toBe(false);
    expect(result.totalBytes).toBeGreaterThan(result.budgetBytes);
  });

  it("dedupes an href referenced by more than one tag", () => {
    writeAsset("../style.css", 100);
    writeAsset("theme.js", 100);
    writeAsset("../font.woff2", 100);
    writeAsset("../app.js", 100);
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

  it("throws a descriptive error when a referenced critical asset is missing from the build output", () => {
    // style.css, theme.js and font.woff2 are written; app.js is not.
    writeAsset("../style.css", 100);
    writeAsset("theme.js", 100);
    writeAsset("../font.woff2", 100);
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
});

describe("evaluateImageBudget", () => {
  it("passes when every image is under the per-file budget", () => {
    writeImage("favicon.svg", 300);
    writeImage("social-card.png", 900);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.withinBudget).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags any image over the per-file budget", () => {
    writeImage("favicon.svg", 300);
    writeImage("unoptimized-screenshot.png", 5000);

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.withinBudget).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].path).toContain("unoptimized-screenshot.png");
  });

  it("checks images in nested directories too", () => {
    mkdirSync(join(imagesDir, "nested"), { recursive: true });
    writeFileSync(
      join(imagesDir, "nested", "big.png"),
      Buffer.alloc(5000, "a"),
    );

    const result = evaluateImageBudget(outDir, 1000);

    expect(result.violations).toHaveLength(1);
  });

  it("throws a descriptive error when the images dir is missing", () => {
    rmSync(imagesDir, { recursive: true, force: true });

    expect(() => evaluateImageBudget(outDir)).toThrow(
      /run `npm run build` first/,
    );
  });
});

describe("evaluatePerformanceBudget", () => {
  it("passes only when both the critical asset and image budgets pass", () => {
    writeAsset("../style.css", 100);
    writeAsset("theme.js", 100);
    writeAsset("../font.woff2", 100);
    writeAsset("../app.js", 100);
    writeIndexHtml(buildHtml());
    writeImage("favicon.svg", 100);

    const result = evaluatePerformanceBudget(outDir);

    expect(result.passed).toBe(true);
    expect(result.criticalAssets.withinBudget).toBe(true);
    expect(result.images.withinBudget).toBe(true);
  });

  it("fails overall when only the image budget is exceeded", () => {
    writeAsset("../style.css", 100);
    writeAsset("theme.js", 100);
    writeAsset("../font.woff2", 100);
    writeAsset("../app.js", 100);
    writeIndexHtml(buildHtml());
    writeImage("unoptimized.png", 10 * 1024 * 1024);

    const result = evaluatePerformanceBudget(outDir);

    expect(result.passed).toBe(false);
    expect(result.criticalAssets.withinBudget).toBe(true);
    expect(result.images.withinBudget).toBe(false);
  });
});
