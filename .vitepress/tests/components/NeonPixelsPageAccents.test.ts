import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { BRAND_ACCENTS } from "@theme/brand";
import { hexToRgba } from "@theme/utils/color";

// Guards the single-source-of-truth binding: the page's accent colors must
// reach the markup through BRAND_ACCENTS / hexToRgba / Tailwind tokens, never
// as a raw hex or rgb() channel literal a palette change would leave stranded.
// The negative half reads the whole source file (template AND script AND style,
// not just <template>) — the refactor moved the glow/gradient composition into
// <script setup>, so a re-hardcode there must fail too. The positive half
// mounts the component and asserts the specific bindings this refactor created
// (the SVG rect fills and the derived glows) still resolve, so deleting a
// binding can't green the suite. Anchored to this file (not process.cwd()) so
// the read still resolves when vitest runs from a subdirectory.
const COMPONENT_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../theme/components/NeonPixelsPage.vue",
  ),
  "utf8",
);

const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i;

// Validate the palette once at load: every downstream derivation (channel
// split, needle match) assumes a clean 6-digit hex, so a malformed accent must
// fail loud here rather than silently greening a `toContain`/`toMatch` guard.
for (const [name, hex] of Object.entries(BRAND_ACCENTS)) {
  if (!SIX_DIGIT_HEX.test(hex)) {
    throw new Error(`BRAND_ACCENTS.${name} is not a 6-digit hex: "${hex}"`);
  }
}

function channelsOf(hex: string) {
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return { red, green, blue };
}

describe("NeonPixelsPage accent bindings", () => {
  it.each(Object.entries(BRAND_ACCENTS))(
    "never hardcodes the %s accent as a hex literal in the source",
    (_name, hex) => {
      expect(COMPONENT_SOURCE.toLowerCase()).not.toContain(hex.toLowerCase());
    },
  );

  it.each(Object.entries(BRAND_ACCENTS))(
    "never hardcodes the %s accent as an rgb() channel triple in the source",
    (_name, hex) => {
      const { red, green, blue } = channelsOf(hex);
      // Anchored to an `rgb(`/`rgba(` opener so an unrelated numeric triple
      // (viewBox, transform) can't false-positive; `[,\s]` still catches both
      // legacy `rgb(r, g, b)` and modern space-separated `rgb(r g b / a)`.
      const channelTriple = new RegExp(
        `rgba?\\(\\s*${red}\\s*[,\\s]\\s*${green}\\s*[,\\s]\\s*${blue}\\b`,
        "i",
      );
      expect(COMPONENT_SOURCE).not.toMatch(channelTriple);
    },
  );

  it("binds the wordmark SVG fills straight to the accent palette", () => {
    const wrapper = mount(NeonPixelsPage);
    const fills = wrapper
      .findAll("svg rect")
      .map((rect) => rect.attributes("fill"));
    // Both wordmarks (header + footer) paint cyan/lime/pink from BRAND_ACCENTS;
    // dropping a `:fill` binding drops the color from this set and fails here.
    expect(fills).toContain(BRAND_ACCENTS.cyan);
    expect(fills).toContain(BRAND_ACCENTS.lime);
    expect(fills).toContain(BRAND_ACCENTS.pink);
    wrapper.unmount();
  });

  it("renders every derived accent glow from hexToRgba, not a literal", () => {
    const html = mount(NeonPixelsPage).html();
    // Each card/aurora glow is the accent at a fixed alpha; asserting the exact
    // hexToRgba output is present catches a dropped `:style` binding that the
    // negative source scan (absence-only) cannot.
    const derivedGlows = [
      hexToRgba(BRAND_ACCENTS.lime, 0.16),
      hexToRgba(BRAND_ACCENTS.pink, 0.15),
      hexToRgba(BRAND_ACCENTS.cyan, 0.13),
      hexToRgba(BRAND_ACCENTS.lime, 0.1),
      hexToRgba(BRAND_ACCENTS.cyan, 0.1),
      hexToRgba(BRAND_ACCENTS.amber, 0.09),
      hexToRgba(BRAND_ACCENTS.pink, 0.8),
      hexToRgba(BRAND_ACCENTS.pink, 0.12),
    ];
    derivedGlows.forEach((glow) => {
      expect(html).toContain(glow);
    });
  });
});
