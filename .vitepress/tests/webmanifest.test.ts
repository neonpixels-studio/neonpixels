import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, resolve } from "node:path";

// Anchored to this test file, not process.cwd(), so the reads still resolve if
// vitest is invoked from a subdirectory or given a custom root.
const PUBLIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../public",
);
const MANIFEST_PATH = resolve(PUBLIC_DIR, "images/site.webmanifest");
const MANIFEST_RAW = readFileSync(MANIFEST_PATH, "utf8");

// scope, start_url and id all pin to the site root. start_url resolves against
// the manifest URL and must fall within scope; id resolves against the site
// origin. Without an explicit scope the default is the manifest's own /images/
// directory, which would put start_url out of scope and break installability.
const SITE_ROOT_PATH = "/";

// Every installability-relevant icon variant the manifest must ship: an
// unmasked (any) and a maskable variant at each install size.
const REQUIRED_ICONS = [
  { purpose: "any", sizes: "192x192" },
  { purpose: "any", sizes: "512x512" },
  { purpose: "maskable", sizes: "192x192" },
  { purpose: "maskable", sizes: "512x512" },
];

// Display modes Chrome accepts as installable; an absent display key defaults
// to "browser", which suppresses the install prompt.
const INSTALLABLE_DISPLAY_MODES = ["fullscreen", "standalone", "minimal-ui"];

const PNG_EXTENSION = ".png";

// PNG dimensions live in the IHDR chunk: the 8-byte signature, then a 4-byte
// chunk length and the 4-byte "IHDR" type, putting width at byte 16 and height
// at byte 20.
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_LENGTH = 24;

interface WebManifestIcon {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}

interface WebManifest {
  name: string;
  short_name: string;
  scope: string;
  start_url: string;
  id: string;
  display: string;
  icons: WebManifestIcon[];
}

// Parsed lazily and cached so a malformed manifest fails inside the "is valid
// JSON" test rather than aborting the whole file at collection time.
let cachedManifest: WebManifest | undefined;

function readManifest() {
  cachedManifest ??= JSON.parse(MANIFEST_RAW) as WebManifest;
  return cachedManifest;
}

// purpose is a space-separated list that defaults to "any" when omitted, so
// match by membership rather than string equality.
function iconHasPurpose(icon: WebManifestIcon, purpose: string) {
  return (icon.purpose ?? "any").split(/\s+/).includes(purpose);
}

// sizes shares purpose's space-separated-list grammar (e.g. "192x192 512x512").
function iconHasSize(icon: WebManifestIcon, size: string) {
  return icon.sizes.split(/\s+/).includes(size);
}

function iconPathFor(iconSrc: string) {
  return resolve(PUBLIC_DIR, iconSrc.replace(/^\//, ""));
}

// Confirms the path is a real file AND its filename case matches disk, since
// macOS (APFS) is case-insensitive but the deployed Linux host is not — a case
// mismatch 404s in prod. Mirrors config.test.ts's isRealFileWithExactCase.
function iconFileExistsWithExactCase(iconSrc: string) {
  const iconPath = iconPathFor(iconSrc);
  const stats = statSync(iconPath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    return false;
  }
  return readdirSync(dirname(iconPath)).includes(basename(iconPath));
}

function pngDimensions(iconSrc: string) {
  const header = readFileSync(iconPathFor(iconSrc)).subarray(
    0,
    PNG_HEADER_LENGTH,
  );
  if (header.length < PNG_HEADER_LENGTH) {
    return null;
  }
  if (!header.subarray(0, PNG_SIGNATURE_LENGTH).equals(PNG_SIGNATURE)) {
    return null;
  }
  const width = header.readUInt32BE(PNG_WIDTH_OFFSET);
  const height = header.readUInt32BE(PNG_HEIGHT_OFFSET);
  return `${width}x${height}`;
}

describe("web app manifest", () => {
  it("is valid JSON", () => {
    expect(() => readManifest()).not.toThrow();
  });

  it("pins scope, start_url and id to the site root for an in-scope launch URL and stable identity", () => {
    const manifest = readManifest();
    expect(manifest.scope).toBe(SITE_ROOT_PATH);
    expect(manifest.start_url).toBe(SITE_ROOT_PATH);
    expect(manifest.id).toBe(SITE_ROOT_PATH);
  });

  it("declares an installable display mode and both names", () => {
    const manifest = readManifest();
    expect(INSTALLABLE_DISPLAY_MODES).toContain(manifest.display);
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
  });

  it("ships at least one icon", () => {
    expect(readManifest().icons.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_ICONS)(
    "ships a $purpose icon at $sizes",
    ({ purpose, sizes }) => {
      const icon = readManifest().icons.find(
        (candidate) =>
          iconHasSize(candidate, sizes) && iconHasPurpose(candidate, purpose),
      );
      expect(icon, `missing ${purpose} icon at ${sizes}`).toBeDefined();
    },
  );

  it("points the any and maskable variants at distinct files", () => {
    const sources = readManifest().icons.map((icon) => icon.src);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("references only existing icon files whose real PNG dimensions match their declared sizes", () => {
    const icons = readManifest().icons;
    for (const icon of icons) {
      expect.soft(iconFileExistsWithExactCase(icon.src), icon.src).toBe(true);
      if (extname(icon.src) !== PNG_EXTENSION) {
        continue;
      }
      expect
        .soft(iconHasSize(icon, pngDimensions(icon.src) ?? ""), icon.src)
        .toBe(true);
    }
  });
});
