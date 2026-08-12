// Single source of truth for the brand accents and the wordmark gradient where
// they're consumed in JS/TS — inline `:style` bindings and component data. The
// CSS-facing equivalents live as custom properties in `style.css`
// (`--color-lime`, `--color-cyan`, …); Tailwind's `@theme` block can't import
// from TS, so those two surfaces are kept in sync by hand (guarded by a test in
// brand.test.ts). Any accent hex change must land in both places.
//
// Scope: this module owns the four per-project accents and the gradient only.
// Per-component derived tints (pill backgrounds, the empty heatmap cell, muted
// title greys) stay local to the component that uses them. The supplementary
// `--color-purple` in style.css is consumed only through a Tailwind class, never
// as a JS literal, so it has nothing to de-duplicate here and stays CSS-only.

export const BRAND_ACCENTS = {
  lime: "#b8ff2e",
  cyan: "#22e0ff",
  pink: "#ff2ea6",
  amber: "#ffc21f",
} as const;

// The animated wordmark gradient sweeps through the four brand accents and
// loops back to lime for a seamless repeat. Composed from BRAND_ACCENTS so the
// gradient can never drift from the accents it's built on.
export const WORDMARK_GRADIENT = `linear-gradient(90deg,${BRAND_ACCENTS.lime},${BRAND_ACCENTS.cyan},${BRAND_ACCENTS.pink},${BRAND_ACCENTS.amber},${BRAND_ACCENTS.lime})`;

const OPAQUE_HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const ALPHA_HEX_PATTERN = /^[0-9a-f]{2}$/i;

// Appends a two-character hex alpha channel to an opaque brand accent, e.g.
// withAlpha(BRAND_ACCENTS.cyan, "88") -> "#22e0ff88". Both arguments are
// validated so a malformed accent or alpha fails loudly here instead of
// silently producing an invalid CSS color the browser drops at paint time.
export function withAlpha(hex: string, alphaHex: string) {
  if (!OPAQUE_HEX_PATTERN.test(hex)) {
    throw new Error(`withAlpha expected a 6-digit hex accent, got "${hex}"`);
  }
  if (!ALPHA_HEX_PATTERN.test(alphaHex)) {
    throw new Error(
      `withAlpha expected a 2-digit hex alpha, got "${alphaHex}"`,
    );
  }
  return `${hex}${alphaHex}`;
}
