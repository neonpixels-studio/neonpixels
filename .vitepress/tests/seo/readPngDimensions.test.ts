import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import config from "../../config";
import {
  HEIGHT_OFFSET,
  IHDR_DATA_LENGTH,
  IHDR_END_OFFSET,
  IHDR_LENGTH_OFFSET,
  IHDR_TYPE_OFFSET,
  PNG_MAX_DIMENSION,
  PNG_SIGNATURE,
  WIDTH_OFFSET,
  readPngDimensions,
} from "../../seo/readPngDimensions";

const SPEC_IHDR_DATA_LENGTH = 13;
const SPEC_MAX_DIMENSION = 2 ** 31 - 1;
const PUBLIC_DIR = resolve(process.cwd(), "public");
const OFFSET_PADDING = 8;
const DIMENSION_BYTES = 8;
const CRC_LENGTH = 4;
const IHDR_TRAILING_BYTES = IHDR_DATA_LENGTH - DIMENSION_BYTES + CRC_LENGTH;
const SOCIAL_CARD_DIMENSIONS = { width: 1200, height: 630 };

function buildPngHeader({
  width,
  height,
  chunkType = "IHDR",
  signature = PNG_SIGNATURE,
  ihdrLength = SPEC_IHDR_DATA_LENGTH,
}: {
  width: number;
  height: number;
  chunkType?: string;
  signature?: number[];
  ihdrLength?: number;
}) {
  const bytes = new Uint8Array(IHDR_END_OFFSET + IHDR_TRAILING_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(signature, 0);
  view.setUint32(IHDR_LENGTH_OFFSET, ihdrLength);
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
    expect(readPngDimensions(buildPngHeader(SOCIAL_CARD_DIMENSIONS))).toEqual({
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

  it.each([
    ["width", { ...SOCIAL_CARD_DIMENSIONS, width: 0 }],
    ["height", { ...SOCIAL_CARD_DIMENSIONS, height: 0 }],
  ])("throws when %s is zero", (name, dimensions) => {
    expect(() => readPngDimensions(buildPngHeader(dimensions))).toThrow(
      new RegExp(`IHDR ${name} must be greater than zero`),
    );
  });

  it.each([
    ["width", { ...SOCIAL_CARD_DIMENSIONS, width: SPEC_MAX_DIMENSION + 1 }],
    ["height", { ...SOCIAL_CARD_DIMENSIONS, height: SPEC_MAX_DIMENSION + 1 }],
  ])("throws when %s exceeds the spec maximum", (name, dimensions) => {
    expect(() => readPngDimensions(buildPngHeader(dimensions))).toThrow(
      new RegExp(`IHDR ${name} must not exceed`),
    );
  });

  it("keeps the exported limits in line with the PNG spec", () => {
    expect(PNG_MAX_DIMENSION).toBe(SPEC_MAX_DIMENSION);
    expect(IHDR_DATA_LENGTH).toBe(SPEC_IHDR_DATA_LENGTH);
  });

  it("accepts dimensions at the spec maximum", () => {
    const dimensions = {
      width: SPEC_MAX_DIMENSION,
      height: SPEC_MAX_DIMENSION,
    };
    expect(readPngDimensions(buildPngHeader(dimensions))).toEqual(dimensions);
  });

  it.each([SPEC_IHDR_DATA_LENGTH - 1, SPEC_IHDR_DATA_LENGTH + 1, 0])(
    "throws when the IHDR length is %i",
    (ihdrLength) => {
      const bytes = buildPngHeader({ ...SOCIAL_CARD_DIMENSIONS, ihdrLength });
      expect(() => readPngDimensions(bytes)).toThrow(/IHDR length/);
    },
  );

  it("throws one byte short of a full IHDR header", () => {
    const bytes = buildPngHeader(SOCIAL_CARD_DIMENSIONS);
    expect(() =>
      readPngDimensions(bytes.subarray(0, IHDR_END_OFFSET - 1)),
    ).toThrow(/too short/);
  });

  it("accepts exactly a full IHDR header", () => {
    const bytes = buildPngHeader(SOCIAL_CARD_DIMENSIONS);
    expect(readPngDimensions(bytes.subarray(0, IHDR_END_OFFSET))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  it("honors a non-zero byteOffset on the input view", () => {
    const header = buildPngHeader(SOCIAL_CARD_DIMENSIONS);
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
