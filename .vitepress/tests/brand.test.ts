import { describe, it, expect } from "vitest";
import { BRAND_ACCENTS, WORDMARK_GRADIENT } from "@theme/brand";

describe("brand", () => {
  it("exposes the four brand accents as hex values", () => {
    expect(BRAND_ACCENTS).toEqual({
      lime: "#b8ff2e",
      cyan: "#22e0ff",
      pink: "#ff2ea6",
      amber: "#ffc21f",
    });
  });

  // Pins the composed gradient to the exact literal it replaced, so a future
  // accent edit can't silently reshape the wordmark's rendered output.
  it("composes the wordmark gradient from the accents, looping back to lime", () => {
    expect(WORDMARK_GRADIENT).toBe(
      "linear-gradient(90deg,#b8ff2e,#22e0ff,#ff2ea6,#ffc21f,#b8ff2e)",
    );
  });
});
