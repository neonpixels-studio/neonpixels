export interface PngDimensions {
  width: number;
  height: number;
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = "IHDR";
export const IHDR_LENGTH_OFFSET = 8;
export const IHDR_DATA_LENGTH = 13;
export const PNG_MAX_DIMENSION = 0x7fffffff;
export const IHDR_TYPE_OFFSET = 12;
export const WIDTH_OFFSET = 16;
export const HEIGHT_OFFSET = 20;
export const IHDR_END_OFFSET = 24;

function invalidPng(reason: string) {
  return new Error(`Not a valid PNG: ${reason}`);
}

function hasPngSignature(bytes: Uint8Array) {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function readChunkType(bytes: Uint8Array) {
  return String.fromCharCode(
    ...bytes.subarray(IHDR_TYPE_OFFSET, IHDR_TYPE_OFFSET + IHDR_TYPE.length),
  );
}

export function readPngDimensions(bytes: Uint8Array): PngDimensions {
  if (bytes.length < IHDR_END_OFFSET) {
    throw invalidPng("file is too short to contain an IHDR chunk");
  }
  if (!hasPngSignature(bytes)) {
    throw invalidPng("missing PNG signature");
  }
  if (readChunkType(bytes) !== IHDR_TYPE) {
    throw invalidPng("first chunk is not IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(IHDR_LENGTH_OFFSET) !== IHDR_DATA_LENGTH) {
    throw invalidPng(`IHDR length must be ${IHDR_DATA_LENGTH}`);
  }
  const width = view.getUint32(WIDTH_OFFSET);
  const height = view.getUint32(HEIGHT_OFFSET);
  if (width === 0 || height === 0) {
    throw invalidPng("IHDR width and height must be greater than zero");
  }
  if (width > PNG_MAX_DIMENSION || height > PNG_MAX_DIMENSION) {
    throw invalidPng(
      `IHDR width and height must not exceed ${PNG_MAX_DIMENSION}`,
    );
  }
  return { width, height };
}
