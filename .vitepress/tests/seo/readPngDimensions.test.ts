import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import config from "../../config";
import {
  HEIGHT_OFFSET,
  IHDR_END_OFFSET,
  IHDR_TYPE_OFFSET,
  PNG_SIGNATURE,
  WIDTH_OFFSET,
  readPngDimensions,
} from "../../seo/readPngDimensions";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const IHDR_LENGTH_OFFSET = 8;
const IHDR_DATA_LENGTH = 13;
const OFFSET_PADDING = 8;

function buildPngHeader({
  width,
  height,
  chunkType = "IHDR",
  signature = PNG_SIGNATURE,
}: {
  width: number;
  height: number;
  chunkType?: string;
  signature?: number[];
}) {
  const bytes = new Uint8Array(IHDR_END_OFFSET + 9);
  const view = new DataView(bytes.buffer);
  bytes.set(signature, 0);
  view.setUint32(IHDR_LENGTH_OFFSET, IHDR_DATA_LENGTH);
  bytes.set(
    [...chunkType].map((char) => char.charCodeAt(0)),
    IHDR_TYPE_OFFSET,
  );
  view.setUint32(WIDTH_OFFSET, width);
  view.setUint32(HEIGHT_OFFSET, height);
  return bytes;
}

function headMetaContent(property: string) {
  const entry = (config.head ?? []).find(
    ([tag, attributes]) => tag === "meta" && attributes?.property === property,
  );
  if (!entry) {
    throw new Error(`No <meta property="${property}"> in VitePress head`);
  }
  const content = (entry[1] as Record<string, unknown>).content;
  if (typeof content !== "string") {
    throw new Error(`<meta property="${property}"> has no content`);
  }
  return content;
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

  it("throws one byte short of a full IHDR header", () => {
    const bytes = buildPngHeader({ width: 1200, height: 630 });
    expect(() =>
      readPngDimensions(bytes.subarray(0, IHDR_END_OFFSET - 1)),
    ).toThrow(/too short/);
  });

  it("accepts exactly a full IHDR header", () => {
    const bytes = buildPngHeader({ width: 1200, height: 630 });
    expect(readPngDimensions(bytes.subarray(0, IHDR_END_OFFSET))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  it("honors a non-zero byteOffset on the input view", () => {
    const header = buildPngHeader({ width: 1200, height: 630 });
    const padded = new Uint8Array(header.length + OFFSET_PADDING);
    padded.set(header, OFFSET_PADDING);
    expect(readPngDimensions(padded.subarray(OFFSET_PADDING))).toEqual({
      width: 1200,
      height: 630,
    });
  });
});

describe("declared og:image dimensions", () => {
  it("match the real image file", () => {
    const imageUrl = new URL(headMetaContent("og:image"));
    const imagePath = resolve(
      PUBLIC_DIR,
      `.${decodeURIComponent(imageUrl.pathname)}`,
    );
    const actual = readPngDimensions(readFileSync(imagePath));

    expect({
      width: Number(headMetaContent("og:image:width")),
      height: Number(headMetaContent("og:image:height")),
    }).toEqual(actual);
  });
});
