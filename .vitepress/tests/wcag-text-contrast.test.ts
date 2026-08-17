import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { contrastRatio } from "@theme/utils/color";

// Anchored to this test file, not process.cwd(), so the read still resolves if
// vitest is invoked from a subdirectory or given a custom root.
const STYLE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../theme/style.css",
  ),
  "utf8",
);

// WCAG 2.1 SC 1.4.3: normal-size body text needs at least this ratio. Both
// tokens under test render at 10.5–12px (never large/bold), so the 3:1
// large-text allowance does not apply.
const WCAG_AA_NORMAL_TEXT = 4.5;

// Every muted foreground token used as text, plus the page background they sit
// on (issue #29 lifted the two faintest, --color-fg-faint/--color-fg-dim; the
// lighter two already pass and are guarded here so a future darkening regresses
// CI). Read from the stylesheet source. Scope note: this guards only these
// named tokens — hardcoded `text-[#hex]` arbitrary values elsewhere in the .vue
// files are out of scope here.
const TOKEN_BACKGROUND = "--color-bg";
const MUTED_TEXT_TOKENS = [
  "--color-fg-faint",
  "--color-fg-dim",
  "--color-fg-subtle",
  "--color-fg-muted",
];

// Every declared value, not just the first: a future theme-scope override
// (e.g. a `.light` block redeclaring the token) must be checked too, or the
// guard silently passes on the shadowed value.
function readTokenValues(name: string): string[] {
  // Left boundary so `--color-bg` can't match a longer `--x-color-bg:` token.
  const pattern = new RegExp(
    `(?:^|[\\s;{])${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
    "g",
  );
  const values = [...STYLE_CSS.matchAll(pattern)].map(([, hex]) => hex);
  if (!values.length) {
    throw new Error(
      `wcag-text-contrast: token "${name}" not found in style.css`,
    );
  }
  return values;
}

// Worst case across every foreground×background pair, so any one shadowed
// declaration that fails AA drags the asserted ratio below the threshold.
function lowestContrast(foregrounds: string[], backgrounds: string[]): number {
  if (!foregrounds.length || !backgrounds.length) {
    throw new Error("wcag-text-contrast: no colors to compare");
  }
  const ratios = foregrounds.flatMap((foreground) =>
    backgrounds.map((background) => contrastRatio(foreground, background)),
  );
  return Math.min(...ratios);
}

describe("muted text tokens meet WCAG AA", () => {
  it.each(MUTED_TEXT_TOKENS)(
    `%s clears ${WCAG_AA_NORMAL_TEXT}:1 against the page background`,
    (token) => {
      const ratio = lowestContrast(
        readTokenValues(token),
        readTokenValues(TOKEN_BACKGROUND),
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );
});
