import { describe, it, expect } from "vitest";
import { hexToRgba } from "@theme/utils/color";

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
});
