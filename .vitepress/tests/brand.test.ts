import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BRAND_ACCENTS, WORDMARK_GRADIENT, withAlpha } from "@theme/brand";

// Anchored to this test file, not process.cwd(), so the read still resolves if
// vitest is invoked from a subdirectory or given a custom root.
const STYLE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../theme/style.css",
  ),
  "utf8",
);

describe("brand", () => {
  // Asserts the gradient's structure — the five accent stops in order, looping
  // back to lime, behind the 90deg prefix — rather than a pinned literal, so an
  // intentional accent change flows through without a false failure here while
  // a dropped/reordered stop still fails.
  it("composes the wordmark gradient from the accents, looping back to lime", () => {
    expect(WORDMARK_GRADIENT).toMatch(/^linear-gradient\(90deg,/);
    expect(WORDMARK_GRADIENT.match(/#[0-9a-f]{6}/gi)).toEqual([
      BRAND_ACCENTS.lime,
      BRAND_ACCENTS.cyan,
      BRAND_ACCENTS.pink,
      BRAND_ACCENTS.amber,
      BRAND_ACCENTS.lime,
    ]);
  });

  // brand.ts (JS-consumed) and style.css @theme tokens (CSS-consumed) mirror the
  // same accent hexes by hand. This is the one drift the two-source design can't
  // prevent structurally, so assert the CSS custom properties still match.
  it.each(Object.entries(BRAND_ACCENTS))(
    "keeps --color-%s in style.css in sync with BRAND_ACCENTS",
    (name, hex) => {
      expect(STYLE_CSS).toMatch(new RegExp(`--color-${name}:\\s*${hex};`, "i"));
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
