import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFontPreloadLink } from "../../fonts/writeFontPreloadLink";

const CRITICAL_FONT_FILENAME = "archivo-latin-900-normal.D5FQlLQC.woff2";
const OTHER_FONT_FILENAME = "jetbrains-mono-latin-400-normal.aBcDeFgH.woff2";
const EXPECTED_HREF = `/assets/${CRITICAL_FONT_FILENAME}`;
const BASE_HTML = `<html><head><title>Neon Pixels</title></head><body></body></html>`;

let workDir = "";
let outDir = "";
let assetsDir = "";

function writeHtmlFile(name: string, contents: string) {
  writeFileSync(join(outDir, name), contents);
}

function writeAssetFile(name: string) {
  writeFileSync(join(assetsDir, name), "");
}

function readHtmlFile(name: string) {
  return readFileSync(join(outDir, name), "utf8");
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "neonpixels-font-preload-"));
  outDir = join(workDir, "dist");
  assetsDir = join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("writeFontPreloadLink", () => {
  it("injects a preload link for the built, content-hashed Archivo 900 asset", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);

    await writeFontPreloadLink(outDir);

    const html = readHtmlFile("index.html");
    expect(html).toContain(`href="${EXPECTED_HREF}"`);
    expect(html).toContain('rel="preload"');
    expect(html).toContain('as="font"');
    expect(html).toContain('type="font/woff2"');
    expect(html).toContain("crossorigin");
  });

  it("places the link before the closing </head> tag", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);

    await writeFontPreloadLink(outDir);

    const html = readHtmlFile("index.html");
    expect(html.indexOf(EXPECTED_HREF)).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf(EXPECTED_HREF)).toBeGreaterThan(html.indexOf("<head>"));
  });

  it("injects the link into every emitted HTML document, including nested pages", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);
    writeHtmlFile("404.html", BASE_HTML);
    mkdirSync(join(outDir, "about"), { recursive: true });
    writeFileSync(join(outDir, "about", "index.html"), BASE_HTML);

    await writeFontPreloadLink(outDir);

    expect(readHtmlFile("index.html")).toContain(EXPECTED_HREF);
    expect(readHtmlFile("404.html")).toContain(EXPECTED_HREF);
    expect(readFileSync(join(outDir, "about", "index.html"), "utf8")).toContain(
      EXPECTED_HREF,
    );
  });

  it("ignores other self-hosted font assets when picking the critical face", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeAssetFile(OTHER_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);

    await writeFontPreloadLink(outDir);

    const html = readHtmlFile("index.html");
    expect(html).toContain(EXPECTED_HREF);
    expect(html).not.toContain(OTHER_FONT_FILENAME);
  });

  it("replaces its own previous link rather than stacking a duplicate on rebuild", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);

    await writeFontPreloadLink(outDir);
    await writeFontPreloadLink(outDir);

    const html = readHtmlFile("index.html");
    expect(html.split(EXPECTED_HREF).length - 1).toBe(1);
    expect(html.split('data-generated="font-preload"').length - 1).toBe(1);
  });

  it("swaps to a new hash on rebuild instead of preloading a stale asset", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", BASE_HTML);
    await writeFontPreloadLink(outDir);

    rmSync(join(assetsDir, CRITICAL_FONT_FILENAME));
    const rebuiltFontFilename = "archivo-latin-900-normal.ZZ99xxYY.woff2";
    writeAssetFile(rebuiltFontFilename);
    await writeFontPreloadLink(outDir);

    const html = readHtmlFile("index.html");
    expect(html).toContain(`/assets/${rebuiltFontFilename}`);
    expect(html).not.toContain(CRITICAL_FONT_FILENAME);
  });

  it("throws when no built asset matches the critical font pattern", async () => {
    writeHtmlFile("index.html", BASE_HTML);

    await expect(writeFontPreloadLink(outDir)).rejects.toThrow(
      /no built asset matching/,
    );
  });

  it("throws when more than one asset matches the critical font pattern", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeAssetFile("archivo-latin-900-normal.OtherHash1.woff2");
    writeHtmlFile("index.html", BASE_HTML);

    await expect(writeFontPreloadLink(outDir)).rejects.toThrow(
      /expected exactly one/,
    );
  });

  it("throws when a built HTML document has no closing </head> tag", async () => {
    writeAssetFile(CRITICAL_FONT_FILENAME);
    writeHtmlFile("index.html", "<html><body>no head here</body></html>");

    await expect(writeFontPreloadLink(outDir)).rejects.toThrow(
      /no closing <\/head> tag/,
    );
  });
});
