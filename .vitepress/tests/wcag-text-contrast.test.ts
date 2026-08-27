import { describe, it, expect, onTestFinished } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import NotFound from "@components/NotFound.vue";
import { contrastRatio, relativeLuminance } from "@theme/utils/color";

// Anchored to this test file, not process.cwd(), so the read still resolves if
// vitest is invoked from a subdirectory or given a custom root.
const STYLE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../theme/style.css",
  ),
  "utf8",
);

// WCAG 2.1 SC 1.4.3: normal-size body text needs at least this ratio. Every
// token and arbitrary hex under test renders at normal weight/size (never
// large/bold), so the 3:1 large-text allowance does not apply.
const WCAG_AA_NORMAL_TEXT = 4.5;

// The page background every element ultimately sits on when no nearer ancestor
// paints an opaque surface (the root carries `bg-bg` → this token).
const PAGE_BACKGROUND_TOKEN = "--color-bg";
const TOKEN_BACKGROUND = PAGE_BACKGROUND_TOKEN;
const MUTED_TEXT_TOKENS = [
  "--color-fg-faint",
  "--color-fg-dim",
  "--color-fg-subtle",
  "--color-fg-muted",
];

// Every declared value, not just the first: a future theme-scope override
// (e.g. a `.light` block redeclaring the token) must be checked too, or the
// guard silently passes on the shadowed value. Returns [] rather than throwing
// so callers resolving a `bg-<name>` class can tell "not a color token" from
// "a real token that failed to read".
function tokenValues(name: string): string[] {
  // Left boundary so `--color-bg` can't match a longer `--x-color-bg:` token.
  const pattern = new RegExp(
    `(?:^|[\\s;{])${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
    "g",
  );
  return [...STYLE_CSS.matchAll(pattern)].map(([, hex]) => hex);
}

function readTokenValues(name: string): string[] {
  const values = tokenValues(name);
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

// The lightest (highest-luminance) surface is the hardest background for the
// light text this site uses, so it is the honest worst case to assert against
// when a layer offers several opaque colors (a gradient's stops, a token with
// theme overrides).
function lightestHex(hexes: string[]): string {
  return hexes.reduce((lightest, hex) =>
    relativeLuminance(hex) > relativeLuminance(lightest) ? hex : lightest,
  );
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

// --- Background resolution -------------------------------------------------
//
// A text element's contrast surface is the nearest ancestor that paints an
// opaque background. Resolving it lets the arbitrary-hex scan below assert every
// hardcoded `text-[#hex]` label against the surface it actually renders on,
// instead of a hand-written allowlist. The resolver reads the opaque-background
// idioms this codebase uses and, crucially, fails loud on any painted surface it
// can't read (a new rgb()/variable/utility form) rather than silently asserting
// against the wrong color — that failure is the signal to teach it the new form.

// An arbitrary Tailwind text color: `text-[#rrggbb]`. Tail/head-anchored and
// six-digit-only so an opacity modifier (`text-[#fff]/60`) or shorthand isn't
// mistaken for an opaque ink.
const ARBITRARY_TEXT_HEX = /(?:^|\s)text-\[(#[0-9a-fA-F]{6})\](?=\s|$)/;

// Opaque `bg-[#rrggbb]` fill. Tail-anchored so an opacity modifier
// (`bg-[#150610]/60`) isn't read as opaque, unprefixed so a responsive
// `md:bg-[...]` (conditional above a breakpoint) isn't asserted unconditionally.
const OPAQUE_BACKGROUND_CLASS = /(?:^|\s)bg-\[(#[0-9a-fA-F]{6})\](?=\s|$)/;

// A theme-token fill: `bg-panel`, `bg-bg`, … → the `--color-<name>` variable.
// Unprefixed and bracket/slash-free so arbitrary and opacity-modified fills fall
// to their own branches, and a variant-prefixed token stays conditional.
const TOKEN_BACKGROUND_CLASS = /(?:^|\s)bg-([a-z][a-z-]*)(?=\s|$)/;

// A background carried at reduced opacity — the surface behind shows through, so
// it does not define the contrast surface and the resolver climbs past it:
// `bg-white/[0.02]`, `bg-[#150610]/60`, `bg-lime/40`.
const TRANSLUCENT_BACKGROUND_CLASS = /(?:^|\s)(?:[a-z-]+:)?bg-\S*\/(?:\[|\d)/;

// Any `bg-*` utility (any variant prefix) — the fail-loud trigger for a painted
// class the branches above didn't resolve.
const PAINTS_BACKGROUND_CLASS = /(?:^|\s)(?:[a-z-]+:)?bg-\S/;

// The value of an inline `background`/`background-color` declaration (not
// `background-image`, a foreground gradient clip here). `-color`-only match
// keeps `background-image`/`-size` from being read as a fill.
const BACKGROUND_DECLARATION =
  /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]*)/gi;

// A fully opaque six-digit hex stop, rejecting an eight-digit `#rrggbbaa`
// (alpha) via the trailing-hex guard.
const OPAQUE_HEX_STOP = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g;

// Alpha forms inside a background value: `#rrggbbaa`, `rgba()`, `hsla()`.
const TRANSLUCENT_BACKGROUND_VALUE = /#[0-9a-fA-F]{8}\b|rgba\(|hsla\(/;

function lastBackgroundValue(style: string): string | null {
  const declarations = [...style.matchAll(BACKGROUND_DECLARATION)];
  if (!declarations.length) {
    return null;
  }
  // Last declaration wins per the cascade.
  return declarations[declarations.length - 1][1].trim();
}

function tokenBackgroundHex(classes: string): string | null {
  const match = classes.match(TOKEN_BACKGROUND_CLASS);
  if (!match) {
    return null;
  }
  const values = tokenValues(`--color-${match[1]}`);
  if (!values.length) {
    return null;
  }
  return lightestHex(values);
}

// The opaque hex a background value resolves to, null for a translucent overlay
// to climb past, or a throw when it is opaque in a form the resolver can't read.
function opaqueHexFromValue(value: string): string | null {
  const opaqueStops = value.match(OPAQUE_HEX_STOP);
  if (opaqueStops) {
    return lightestHex(opaqueStops);
  }
  if (TRANSLUCENT_BACKGROUND_VALUE.test(value)) {
    return null;
  }
  throw new Error(
    `wcag-text-contrast: background "${value}" is opaque but unreadable (rgb/hsl/var/named) — teach readLayerBackground the new form`,
  );
}

// The opaque background this one element paints, or null when it paints nothing
// opaque (transparent, or a translucent overlay to climb past). Throws when an
// element paints a background the resolver can't read, so a new idiom fails loud
// instead of asserting against the wrong surface.
function readLayerBackground(element: Element): string | null {
  const style = element.getAttribute("style") ?? "";
  // Inline styles win the cascade, so an inline background decides this layer
  // outright — a translucent one climbs past (null) rather than falling through
  // to a class fill it overrides.
  const inlineBackground = lastBackgroundValue(style);
  if (inlineBackground) {
    return opaqueHexFromValue(inlineBackground);
  }
  // getAttribute (not `.className`) keeps SVG ancestors, whose className is an
  // SVGAnimatedString, from throwing.
  const classes = element.getAttribute("class") ?? "";
  const opaqueClass = classes.match(OPAQUE_BACKGROUND_CLASS);
  if (opaqueClass) {
    return opaqueClass[1];
  }
  if (TRANSLUCENT_BACKGROUND_CLASS.test(classes)) {
    return null;
  }
  const tokenHex = tokenBackgroundHex(classes);
  if (tokenHex) {
    return tokenHex;
  }
  if (PAINTS_BACKGROUND_CLASS.test(classes)) {
    throw new Error(
      "wcag-text-contrast: background class this resolver can't read (rgb/var/unknown utility/variant) — teach readLayerBackground the new form",
    );
  }
  return null;
}

// Climb ancestors to the nearest opaque background, or null if none paints one.
function climbForBackground(element: Element): string | null {
  let ancestor: Element | null = element;
  while (ancestor) {
    const background = readLayerBackground(ancestor);
    if (background) {
      return background;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

// Panels must sit on a tinted panel ancestor: reaching the root without one is a
// bug (a label moved off its panel), so fail loud rather than assert on a stale
// pairing.
function panelBackgroundOf(element: Element): string {
  const background = climbForBackground(element);
  if (!background) {
    throw new Error("wcag-text-contrast: label has no tinted panel ancestor");
  }
  return background;
}

// Arbitrary hex text can live anywhere, so an element with no opaque ancestor
// falls back to the page background it renders on.
function resolvedBackgroundOf(element: Element): string {
  return (
    climbForBackground(element) ??
    lightestHex(readTokenValues(PAGE_BACKGROUND_TOKEN))
  );
}

function foregroundHexOf(element: Element): string | null {
  const match = (element.getAttribute("class") ?? "").match(ARBITRARY_TEXT_HEX);
  return match ? match[1] : null;
}

// Per-project stat-block micro-labels (issue #38 lifted the two hardcoded
// `text-[#hex]` values that failed AA on their tinted panels). These sit on the
// project panels, not --color-bg, so the guard mounts the page and reads each
// label's *rendered* panel background rather than a hardcoded pairing.
const LABELS_ON_PANELS = [
  { token: "--color-wanderist-label", className: "text-wanderist-label" },
  { token: "--color-markpost-label", className: "text-markpost-label" },
];

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

// The ratchet: every element carrying an arbitrary `text-[#hex]` class, scanned
// exhaustively and asserted against its resolved background. A future hardcoded
// label that fails AA regresses CI here with no hand-written allowlist entry —
// and one on a background the resolver can't read fails loud (see
// readLayerBackground) rather than passing silently.
// `minHexElements` guards against a broken scan (bad selector, a component that
// stopped rendering its hex labels) silently passing with zero elements found.
// Set below each component's real count so ordinary design churn doesn't trip it
// while a scan that finds nothing still fails.
const HEX_TEXT_HOSTS = [
  { name: "NeonPixelsPage", component: NeonPixelsPage, minHexElements: 8 },
  { name: "NotFound", component: NotFound, minHexElements: 4 },
];

function hexTextElements(root: Element): Element[] {
  const candidates = [...root.querySelectorAll('[class*="text-["]')];
  return candidates.filter((element) => foregroundHexOf(element) !== null);
}

describe("arbitrary text-[#hex] elements meet WCAG AA", () => {
  it.each(HEX_TEXT_HOSTS)(
    `every text-[#hex] in $name clears ${WCAG_AA_NORMAL_TEXT}:1 on its resolved background`,
    ({ component, minHexElements }) => {
      const wrapper = mount(component);
      onTestFinished(() => wrapper.unmount());
      const elements = hexTextElements(wrapper.element);
      expect(elements.length).toBeGreaterThanOrEqual(minHexElements);
      const failures = elements
        .map((element) => {
          const foreground = foregroundHexOf(element) as string;
          const background = resolvedBackgroundOf(element);
          return {
            foreground,
            background,
            ratio: contrastRatio(foreground, background),
          };
        })
        .filter(({ ratio }) => ratio < WCAG_AA_NORMAL_TEXT);
      expect(failures).toEqual([]);
    },
  );
});

// --- Resolver fixtures -----------------------------------------------------
//
// Prove the mechanism the scan relies on: backgrounds resolve to the right
// surface, the ratchet genuinely fails on a low-contrast label, and an
// unreadable painted surface fails loud instead of passing.

function fixtureLeaf(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const leaf = host.querySelector("[data-leaf]");
  if (!leaf) {
    throw new Error("fixtureLeaf: fixture has no [data-leaf] element");
  }
  return leaf;
}

describe("background resolver", () => {
  it("reads an opaque inline background", () => {
    const leaf = fixtureLeaf(
      '<div style="background: #08080a"><span data-leaf class="text-[#d4d4d8]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#08080a");
  });

  it("takes the lightest stop of a gradient as the worst-case surface", () => {
    const leaf = fixtureLeaf(
      '<section style="background: linear-gradient(100deg, #180618 0%, #08080a 58%)"><span data-leaf class="text-[#a8a8b3]">x</span></section>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#180618");
  });

  it("resolves a theme-token background class", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("climbs past a translucent overlay to the surface behind", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><header style="background: #08080ae6"><span data-leaf class="text-[#f2f2f4]">x</span></header></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("falls back to the page background when nothing opaque is painted", () => {
    const leaf = fixtureLeaf(
      '<div><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(
      lightestHex(readTokenValues(PAGE_BACKGROUND_TOKEN)),
    );
  });

  it("fails the AA guard when a text-[#hex] label is too dim for its surface", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><span data-leaf class="text-[#4a4a4a]">x</span></div>',
    );
    const ratio = contrastRatio(
      foregroundHexOf(leaf) as string,
      resolvedBackgroundOf(leaf),
    );
    expect(ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });

  it("passes the AA guard for a legible text-[#hex] label", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><span data-leaf class="text-[#a8a8b3]">x</span></div>',
    );
    const ratio = contrastRatio(
      foregroundHexOf(leaf) as string,
      resolvedBackgroundOf(leaf),
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it("fails loud on an opaque background it cannot read", () => {
    const leaf = fixtureLeaf(
      '<div style="background: rgb(20, 20, 20)"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => resolvedBackgroundOf(leaf)).toThrow(/opaque but unreadable/);
  });
});
