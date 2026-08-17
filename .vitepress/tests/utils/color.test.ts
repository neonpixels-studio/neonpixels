import { describe, it, expect } from "vitest";
import {
  hexToRgba,
  relativeLuminance,
  contrastRatio,
} from "@theme/utils/color";

describe("hexToRgba", () => {
  it("converts a six-digit hex to an rgba() string at the given alpha", () => {
    expect(hexToRgba("#b8ff2e", 0.18)).toBe("rgba(184, 255, 46, 0.18)");
  });

  it("tolerates a hex without the leading hash", () => {
    expect(hexToRgba("22e0ff", 0.6)).toBe("rgba(34, 224, 255, 0.6)");
  });

  it("keeps full opacity when alpha is 1", () => {
    expect(hexToRgba("#ff2ea6", 1)).toBe("rgba(255, 46, 166, 1)");
  });

  it("throws on a shorthand three-digit hex rather than emitting NaN", () => {
    expect(() => hexToRgba("#fff", 0.5)).toThrow(/six-digit hex/);
  });

  it("throws on a non-hex string", () => {
    expect(() => hexToRgba("nope", 0.5)).toThrow(/six-digit hex/);
  });

  it("throws when alpha is out of the 0–1 range or NaN", () => {
    expect(() => hexToRgba("#b8ff2e", Number.NaN)).toThrow(/alpha/);
    expect(() => hexToRgba("#b8ff2e", 1.5)).toThrow(/alpha/);
  });

  it("reports a bad hex before a bad alpha when both are wrong", () => {
    expect(() => hexToRgba("nope", 1.5)).toThrow(/six-digit hex/);
  });
});

describe("relativeLuminance", () => {
  it("returns 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("weights green more heavily than red or blue", () => {
    const green = relativeLuminance("#00ff00");
    const red = relativeLuminance("#ff0000");
    const blue = relativeLuminance("#0000ff");
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });

  it("throws on a malformed hex rather than returning NaN", () => {
    expect(() => relativeLuminance("#fff")).toThrow(/six-digit hex/);
  });
});

describe("contrastRatio", () => {
  it("returns the maximal 21:1 for black against white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
  });

  it("returns 1:1 for a color against itself", () => {
    expect(contrastRatio("#7d7d88", "#7d7d88")).toBeCloseTo(1, 5);
  });

  it("is order-independent between foreground and background", () => {
    expect(contrastRatio("#787882", "#08080a")).toBeCloseTo(
      contrastRatio("#08080a", "#787882"),
      5,
    );
  });
});
