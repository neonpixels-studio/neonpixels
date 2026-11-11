export interface PngDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = "IHDR";
const IHDR_TYPE_OFFSET = 12;
const WIDTH_OFFSET = 16;
const HEIGHT_OFFSET = 20;
const IHDR_END_OFFSET = 24;

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
    throw new Error(
      "Not a valid PNG: file is too short to contain an IHDR chunk",
    );
  }
  if (!hasPngSignature(bytes)) {
    throw new Error("Not a valid PNG: missing PNG signature");
  }
  if (readChunkType(bytes) !== IHDR_TYPE) {
    throw new Error("Not a valid PNG: first chunk is not IHDR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(WIDTH_OFFSET),
    height: view.getUint32(HEIGHT_OFFSET),
  };
}
