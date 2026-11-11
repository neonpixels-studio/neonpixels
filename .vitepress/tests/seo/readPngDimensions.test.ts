import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import config from "../../config";
import { readPngDimensions } from "../../seo/readPngDimensions";

const PUBLIC_DIR = resolve(process.cwd(), "public");

function buildPngHeader({
  width,
  height,
  chunkType = "IHDR",
  signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
}: {
  width: number;
  height: number;
  chunkType?: string;
  signature?: number[];
}) {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set(signature, 0);
  view.setUint32(8, 13);
  bytes.set(
    [...chunkType].map((char) => char.charCodeAt(0)),
    12,
  );
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function headMetaContent(property: string) {
  const entry = (config.head ?? []).find(
    ([tag, attrs]) => tag === "meta" && attrs?.property === property,
  );
  if (!entry) {
    throw new Error(`No <meta property="${property}"> in VitePress head`);
  }
  return String((entry[1] as Record<string, string>).content);
}

describe("readPngDimensions", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(
      readPngDimensions(buildPngHeader({ width: 1200, height: 630 })),
    ).toEqual({
      width: 1200,
      height: 630,
    });
  });

  it("throws on a missing PNG signature", () => {
    const bytes = buildPngHeader({
      width: 1,
      height: 1,
      signature: [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0],
    });
    expect(() => readPngDimensions(bytes)).toThrow(/signature/);
  });

  it("throws when the first chunk is not IHDR", () => {
    const bytes = buildPngHeader({ width: 1, height: 1, chunkType: "IDAT" });
    expect(() => readPngDimensions(bytes)).toThrow(/IHDR/);
  });

  it("throws on truncated input", () => {
    expect(() => readPngDimensions(new Uint8Array(10))).toThrow(/too short/);
  });
});

describe("declared og:image dimensions", () => {
  it("match the real image file", () => {
    const imageUrl = new URL(headMetaContent("og:image"));
    const imagePath = resolve(PUBLIC_DIR, `.${imageUrl.pathname}`);
    const actual = readPngDimensions(readFileSync(imagePath));

    expect({
      width: Number(headMetaContent("og:image:width")),
      height: Number(headMetaContent("og:image:height")),
    }).toEqual(actual);
  });
});
