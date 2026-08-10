import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRAND_ACCENTS, WORDMARK_GRADIENT, withAlpha } from "@theme/brand";

const STYLE_CSS_PATH = resolve(process.cwd(), ".vitepress/theme/style.css");

describe("brand", () => {
  // Pins the composed gradient to the exact literal it replaced, so a future
  // accent edit can't silently reshape the wordmark's rendered output.
  it("composes the wordmark gradient from the accents, looping back to lime", () => {
    expect(WORDMARK_GRADIENT).toBe(
      "linear-gradient(90deg,#b8ff2e,#22e0ff,#ff2ea6,#ffc21f,#b8ff2e)",
    );
  });

  // brand.ts (JS-consumed) and style.css @theme tokens (CSS-consumed) mirror the
  // same accent hexes by hand. This is the one drift the two-source design can't
  // prevent structurally, so assert the CSS custom properties still match.
  it.each(Object.entries(BRAND_ACCENTS))(
    "keeps --color-%s in style.css in sync with BRAND_ACCENTS",
    (name, hex) => {
      const styleCss = readFileSync(STYLE_CSS_PATH, "utf8");
      expect(styleCss).toMatch(new RegExp(`--color-${name}:\\s*${hex};`));
    },
  );

  describe("withAlpha", () => {
    it("appends a hex alpha channel to an opaque accent", () => {
      expect(withAlpha(BRAND_ACCENTS.cyan, "88")).toBe("#22e0ff88");
    });

    it("throws on a value that isn't a 6-digit hex accent", () => {
      expect(() => withAlpha("rgb(34, 224, 255)", "88")).toThrow();
    });
  });
});
