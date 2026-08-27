import { describe, it, expect, onTestFinished } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
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

// Per-project stat-block micro-labels (issue #38 lifted the two hardcoded
// `text-[#hex]` values that failed AA on their tinted panels). These sit on the
// project panels, not --color-bg, so the guard mounts the page and reads each
// label's *rendered* panel background rather than a hardcoded pairing — moving a
// label off its panel, or retinting the panel under it, fails loud instead of
// asserting against a stale hex.
const LABELS_ON_PANELS = [
  { token: "--color-wanderist-label", className: "text-wanderist-label" },
  { token: "--color-markpost-label", className: "text-markpost-label" },
];

// A label's contrast surface is the nearest ancestor that paints a background.
// Read the two opaque-hex idioms this component uses — an unprefixed
// `bg-[#rrggbb]` Tailwind class and an inline `background`/`background-color`
// style — with the inline style winning per the cascade. The class match is
// tail-anchored so an opacity modifier (`bg-[#150610]/60`) isn't mistaken for an
// opaque fill, and unprefixed so a responsive `md:bg-[...]` (which only applies
// above a breakpoint) isn't asserted as unconditional. getAttribute (not
// `.className`) keeps SVG ancestors, whose className is an SVGAnimatedString,
// from throwing.
const PANEL_BACKGROUND_CLASS = /(?:^|\s)bg-\[(#[0-9a-fA-F]{6})\](?=\s|$)/;
const PANEL_BACKGROUND_STYLE = /background(?:-color)?:\s*(#[0-9a-fA-F]{6})/;

// An ancestor that paints *a* background (a color bg-* utility, a `background`,
// `background-color`, or `background-image` style) but not in a form the
// extractors above understand — a token class, rgb()/alpha/shorthand hex, a
// gradient/image, a variant prefix. Climbing past it would silently assert the
// label against a surface it doesn't render on, so fail loud instead.
const PAINTS_BACKGROUND_STYLE = /background(?:-color|-image)?:/;

// Exact Tailwind (v4) `bg-*` utilities that set background-size/-position/
// -repeat/-attachment or an empty/transparent surface rather than a color. An
// ancestor carrying only these paints no contrast surface, so it must not count
// as a background paint. (Gradient/image utilities like `bg-linear-to-r` *do*
// paint and are deliberately absent — they trip the fail-loud, same as an inline
// `background-image`.)
const NON_COLOR_BACKGROUND_UTILITIES = new Set([
  "bg-auto",
  "bg-cover",
  "bg-contain",
  "bg-top",
  "bg-top-left",
  "bg-top-right",
  "bg-bottom",
  "bg-bottom-left",
  "bg-bottom-right",
  "bg-left",
  "bg-right",
  "bg-center",
  "bg-repeat",
  "bg-no-repeat",
  "bg-repeat-x",
  "bg-repeat-y",
  "bg-repeat-round",
  "bg-repeat-space",
  "bg-fixed",
  "bg-local",
  "bg-scroll",
  "bg-none",
  "bg-transparent",
]);

// Non-color `bg-*` families whose every value is a keyword, never a color:
// background-clip, background-origin, background-blend-mode.
const NON_COLOR_BACKGROUND_PREFIXES = ["bg-clip-", "bg-origin-", "bg-blend-"];

// Strip every leading variant segment (`md:`, `2xl:`, stacked `md:hover:`) so the
// base utility is classified, stopping at `[` so an arbitrary value's own colon
// (`bg-[url(data:...)]`) isn't eaten.
function isColorBackgroundUtility(utility: string): boolean {
  const base = utility.replace(/^(?:[^\s:[\]]+:)+/, "");
  if (!base.startsWith("bg-")) {
    return false;
  }
  if (NON_COLOR_BACKGROUND_UTILITIES.has(base)) {
    return false;
  }
  return !NON_COLOR_BACKGROUND_PREFIXES.some((prefix) =>
    base.startsWith(prefix),
  );
}

function classesPaintColorBackground(classes: string): boolean {
  return classes.split(/\s+/).some(isColorBackgroundUtility);
}

function readPanelBackground(element: Element): string | null {
  const classes = element.getAttribute("class") ?? "";
  const style = element.getAttribute("style") ?? "";
  const hex =
    style.match(PANEL_BACKGROUND_STYLE) ??
    classes.match(PANEL_BACKGROUND_CLASS);
  if (hex) {
    return hex[1];
  }
  const paints =
    PAINTS_BACKGROUND_STYLE.test(style) || classesPaintColorBackground(classes);
  if (paints) {
    throw new Error(
      "wcag-text-contrast: panel paints a background this resolver can't read (token/alpha/rgb/variant) — teach readPanelBackground the new form",
    );
  }
  return null;
}

function panelBackgroundOf(element: Element): string {
  let ancestor: Element | null = element;
  while (ancestor) {
    const background = readPanelBackground(ancestor);
    if (background) {
      return background;
    }
    ancestor = ancestor.parentElement;
  }
  throw new Error("wcag-text-contrast: label has no tinted panel ancestor");
}

describe("stat-block micro-labels meet WCAG AA", () => {
  it.each(LABELS_ON_PANELS)(
    `$token clears ${WCAG_AA_NORMAL_TEXT}:1 on every panel it renders on`,
    ({ token, className }) => {
      const wrapper = mount(NeonPixelsPage);
      onTestFinished(() => wrapper.unmount());
      const labels = wrapper.findAll(`.${className}`);
      expect(labels.length).toBeGreaterThan(0);
      const backgrounds = labels.map((label) =>
        panelBackgroundOf(label.element),
      );
      const ratio = lowestContrast(readTokenValues(token), backgrounds);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );
});

function elementWith(attributes: { class?: string; style?: string }): Element {
  const element = document.createElement("div");
  if (attributes.class) {
    element.setAttribute("class", attributes.class);
  }
  if (attributes.style) {
    element.setAttribute("style", attributes.style);
  }
  return element;
}

const UNREADABLE_BACKGROUND_MESSAGE =
  /paints a background this resolver can't read/;

describe("readPanelBackground background detection", () => {
  it("fails loud on an inline background-image it can't read", () => {
    const element = elementWith({ style: "background-image: url(/hero.png);" });
    expect(() => readPanelBackground(element)).toThrow(
      UNREADABLE_BACKGROUND_MESSAGE,
    );
  });

  it("fails loud on a gradient background-image utility", () => {
    const element = elementWith({ class: "bg-linear-to-r from-black" });
    expect(() => readPanelBackground(element)).toThrow(
      UNREADABLE_BACKGROUND_MESSAGE,
    );
  });

  it.each(["bg-cover", "bg-center", "bg-clip-text"])(
    "does not count non-color utility %s as a background paint",
    (utility) => {
      const element = elementWith({ class: `${utility} text-white` });
      expect(readPanelBackground(element)).toBeNull();
    },
  );

  it("ignores a variant-prefixed non-color utility", () => {
    const element = elementWith({ class: "md:bg-cover" });
    expect(readPanelBackground(element)).toBeNull();
  });

  it.each(["md:bg-slate-900", "2xl:bg-slate-900"])(
    "still fails loud on a variant-prefixed color utility %s",
    (utility) => {
      const element = elementWith({ class: utility });
      expect(() => readPanelBackground(element)).toThrow(
        UNREADABLE_BACKGROUND_MESSAGE,
      );
    },
  );

  it("still fails loud on a color bg-* utility it can't read", () => {
    const element = elementWith({ class: "bg-slate-900" });
    expect(() => readPanelBackground(element)).toThrow(
      UNREADABLE_BACKGROUND_MESSAGE,
    );
  });

  it("reads an opaque bg-[#rrggbb] utility without failing loud", () => {
    const element = elementWith({ class: "bg-[#1a1a1a]" });
    expect(readPanelBackground(element)).toBe("#1a1a1a");
  });

  it("reads an inline background-color hex without failing loud", () => {
    const element = elementWith({ style: "background-color: #1a1a1a;" });
    expect(readPanelBackground(element)).toBe("#1a1a1a");
  });
});
