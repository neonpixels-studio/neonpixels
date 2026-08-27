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
        readTokenValues(PAGE_BACKGROUND_TOKEN),
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
// idioms this codebase uses in `class`/`style` (utilities, inline fills), and
// fails loud on an unconditional painted surface it can't read (a new
// rgb()/variable form) rather than silently asserting against the wrong color —
// that failure is the signal to teach it the new form. Out of scope, since they
// aren't on the element: fills declared in a component's scoped `<style>` block,
// and conditional (`hover:`/`dark:`/`[&…]:`) fills that don't paint the default
// state — those are climbed past.

// One definition of a Tailwind class token's boundaries, shared by every
// class matcher so they agree on what a variant and a word boundary are: a left
// edge (start or whitespace), optional stacked standard variants (`dark:hover:`),
// the token body, then a right edge. `variants: false` (default) refuses a
// variant prefix — a fill read as unconditional must not actually be one.
// Arbitrary-selector variants (`[&>a]:`) aren't standard segments, so a fill
// behind one isn't matched — correctly, since it paints a child, not this
// element, and is climbed past like any conditional fill.
const STACKED_VARIANT_PREFIX = "(?:[a-z][\\w-]*:)*";
function classTokenPattern(
  body: string,
  { variants = false, flags = "" }: { variants?: boolean; flags?: string } = {},
): RegExp {
  const prefix = variants ? STACKED_VARIANT_PREFIX : "";
  return new RegExp(`(?:^|\\s)${prefix}${body}(?=\\s|$)`, flags);
}

// An arbitrary Tailwind text color: `text-[<value>]`, with any stacked variant
// prefix and opacity modifier captured so the scan can tell an opaque hex ink
// apart from a conditional or translucent one, and from a non-color arbitrary
// value like `text-[15px]`.
const ARBITRARY_TEXT_VALUE = new RegExp(
  `(?:^|\\s)(${STACKED_VARIANT_PREFIX})text-\\[([^\\]]+)\\](\\/\\S+)?(?=\\s|$)`,
  "g",
);
// A bracket value that is a length/number/function rather than a color
// (`text-[15px]`, `text-[calc(...)]`): skipped. Anything else in a `text-[…]` is
// treated as a color and must read as a clean opaque hex or fail loud — the
// fail-loud trigger on the foreground side, mirroring readLayerBackground.
const NON_COLOR_TEXT_VALUE =
  /^-?[\d.]+(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex)?$|^(?:calc|clamp|min|max)\(/i;
const OPAQUE_TEXT_HEX = /^#[0-9a-fA-F]{6}$/;

// Opaque `bg-[#rrggbb]` fill. Tail-anchored so an opacity modifier
// (`bg-[#150610]/60`) isn't read as opaque, unprefixed so a responsive
// `md:bg-[...]` (conditional above a breakpoint) isn't asserted unconditionally.
const OPAQUE_BACKGROUND_CLASS = classTokenPattern("bg-\\[(#[0-9a-fA-F]{6})\\]");

// A theme-token fill: `bg-panel`, `bg-bg`, … → the `--color-<name>` variable.
// Unprefixed and bracket/slash-free so arbitrary and opacity-modified fills fall
// to their own branches, and a variant-prefixed token stays conditional.
const TOKEN_BACKGROUND_CLASS = classTokenPattern("bg-([a-z][a-z-]*)");

// A background carried at reduced opacity: `bg-white/[0.02]`, `bg-[#150610]/60`,
// `bg-lime/40`. Composited over the surface behind (or, when its base color
// can't be resolved, climbed past).
const CLASS_OVERLAY = new RegExp(
  `(?:^|\\s)bg-(?:\\[(#[0-9a-fA-F]{6})\\]|([a-z][a-z-]*))\\/(?:\\[([\\d.]+)\\]|(\\d{1,3}))(?=\\s|$)`,
);
const TRANSLUCENT_BACKGROUND_CLASS = classTokenPattern(
  "bg-\\S+\\/(?:\\[[\\d.]+\\]|\\d{1,3})",
  { variants: true },
);

// Every `bg-*` utility on an element (with any variant prefix), so a non-color
// utility (`bg-no-repeat`) sitting before a real fill (`bg-panel`) can't mask it.
const ALL_BACKGROUND_TOKENS = classTokenPattern("bg-\\S+", {
  variants: true,
  flags: "g",
});

// `bg-*` utilities that paint no surface color — the utility governs
// image/position/repeat/attachment/reset rather than a fill. Climbed past, not
// read as a surface and not treated as an unreadable fill.
const NON_COLOR_BACKGROUND_CLASS = classTokenPattern(
  "bg-(?:clip-\\w+|origin-\\w+|blend-\\w+|fixed|local|scroll|cover|contain|auto|repeat(?:-x|-y|-round|-space)?|no-repeat|top|bottom|left|right|center|none|transparent|current|inherit)",
  { variants: true },
);

// An element that clips its background to its text: the background is foreground
// ink, not a contrast surface, so climb to what the text actually sits on.
const CLIPS_TO_TEXT = classTokenPattern("bg-clip-text", { variants: true });

// The unprefixed theme-token name of a single `bg-<name>` token, or null.
function backgroundTokenName(token: string): string | null {
  const match = token.match(TOKEN_BACKGROUND_CLASS);
  return match ? match[1] : null;
}

// The property and value of an inline `background`/`background-color`/
// `background-image` declaration. `background-image` counts because it can be a
// real fill (the NotFound CTA), unless the element clips it to its text (handled
// separately). The `-color|-image`-only alternation keeps `background-size`/
// `-position` out.
const BACKGROUND_DECLARATION =
  /(?:^|;)\s*(background(?:-color|-image)?)\s*:\s*([^;]*)/gi;

// A fully opaque six-digit hex stop, rejecting an eight-digit `#rrggbbaa`
// (alpha) via the trailing-hex guard.
const OPAQUE_HEX_STOP = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g;

// An eight-digit `#rrggbbaa` (base + alpha) as a whole inline value.
const HEX_WITH_ALPHA = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/;

// The first `rgb()`/`rgba()` in a value, capturing channels and optional alpha.
const RGBA_VALUE =
  /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/i;

// Keywords that paint nothing at all (bare, no hex present) — climbed past.
const NON_PAINTING_VALUE = /^(?:none|inherit|initial|unset|revert)$/i;

// A translucent layer to composite: an opaque base color and its alpha (0–1).
type Overlay = { base: string; alpha: number };
// What one element's background contributes: an opaque hex, a translucent
// overlay to composite over the surface behind, or null (paints nothing / climb).
type ResolvedLayer = string | Overlay | null;

function valuePaints(value: string): boolean {
  const trimmed = value.trim();
  return !NON_PAINTING_VALUE.test(trimmed) && !/^transparent$/i.test(trimmed);
}

// `background-image` (and the `background` shorthand) paint over
// `background-color`, so prefer the last image/shorthand layer that actually
// paints; fall back to the last `background-color` when none does (e.g.
// `background-image: none; background-color: #fff`).
function lastBackgroundValue(style: string): string | null {
  const declarations = [...style.matchAll(BACKGROUND_DECLARATION)];
  if (!declarations.length) {
    return null;
  }
  const imageLayers = declarations.filter(
    ([, property, value]) => !/-color$/i.test(property) && valuePaints(value),
  );
  const chosen = (imageLayers.length ? imageLayers : declarations).at(-1);
  return chosen ? chosen[2].trim() : null;
}

// Resolve a color name to its worst-case hex: a `--color-<name>` theme token
// (lightest across any override), or Tailwind's built-in white/black. Null for a
// name that isn't a color, so callers can tell a fill from a utility.
function tokenHex(name: string): string | null {
  const values = tokenValues(`--color-${name}`);
  if (values.length) {
    return lightestHex(values);
  }
  if (name === "white") {
    return "#ffffff";
  }
  if (name === "black") {
    return "#000000";
  }
  return null;
}

function parseAlpha(raw: string): number {
  return raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
}

// A `bg-…/opacity` fill as an overlay, or null when its base color can't be
// resolved (climb and approximate rather than assert on a guess).
function classOverlay(classes: string): Overlay | null {
  const match = classes.match(CLASS_OVERLAY);
  if (!match) {
    return null;
  }
  const [, hex, name, bracketOpacity, numericOpacity] = match;
  const base = hex ?? tokenHex(name);
  if (!base) {
    return null;
  }
  const alpha = bracketOpacity
    ? parseFloat(bracketOpacity)
    : parseInt(numericOpacity, 10) / 100;
  return { base, alpha };
}

// What an inline background value contributes. A whole-value alpha hex or an
// rgba() becomes an overlay to composite. Otherwise an opaque hex stop wins —
// even in a gradient that also fades to `transparent`, since the opaque end is a
// real surface and its lightest point is the honest worst case. Only a value
// that is *entirely* transparent/non-painting climbs; anything else opaque but
// unreadable fails loud.
function layerFromValue(value: string): ResolvedLayer {
  const trimmed = value.trim();
  const withAlpha = trimmed.match(HEX_WITH_ALPHA);
  if (withAlpha) {
    return {
      base: `#${withAlpha[1]}`,
      alpha: parseInt(withAlpha[2], 16) / 255,
    };
  }
  const opaqueStops = trimmed.match(OPAQUE_HEX_STOP);
  if (opaqueStops) {
    return lightestHex(opaqueStops);
  }
  const rgba = trimmed.match(RGBA_VALUE);
  if (rgba) {
    const base = channelsToHex({
      red: Number(rgba[1]),
      green: Number(rgba[2]),
      blue: Number(rgba[3]),
    });
    const alpha = rgba[4] === undefined ? 1 : parseAlpha(rgba[4]);
    return alpha >= 1 ? base : { base, alpha };
  }
  // No readable opaque stop. Ignoring `transparent`, if a color the resolver
  // can't read still remains (a var()/hsl()/named paint, alone or as another
  // gradient stop), fail loud; otherwise the value only paints transparent/
  // nothing, so climb.
  const readableColorRemains = trimmed
    .replace(/\btransparent\b/gi, "")
    .match(
      /#[0-9a-fA-F]+|\b(?:rgb|hsl|oklch|oklab|lab|lch|color|var)\s*\(|--\w/i,
    );
  if (readableColorRemains) {
    throw new Error(
      `wcag-text-contrast: background "${value}" is opaque but unreadable (rgb/hsl/var/named) — teach readLayerBackground the new form`,
    );
  }
  return null;
}

type RgbChannels = { red: number; green: number; blue: number };

function hexToChannels(hex: string): RgbChannels {
  const digits = hex.replace("#", "");
  return {
    red: parseInt(digits.slice(0, 2), 16),
    green: parseInt(digits.slice(2, 4), 16),
    blue: parseInt(digits.slice(4, 6), 16),
  };
}

function channelsToHex({ red, green, blue }: RgbChannels): string {
  const toHex = (channel: number) =>
    Math.round(channel).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

// Alpha-composite an overlay over the surface behind it, so a translucent layer
// is measured against the color it actually produces rather than dropped.
function compositeOver(overlay: Overlay, backdrop: string): string {
  const top = hexToChannels(overlay.base);
  const under = hexToChannels(backdrop);
  const mix = (source: number, behind: number) =>
    source * overlay.alpha + behind * (1 - overlay.alpha);
  return channelsToHex({
    red: mix(top.red, under.red),
    green: mix(top.green, under.green),
    blue: mix(top.blue, under.blue),
  });
}

function pageBackgroundHex(): string {
  return lightestHex(readTokenValues(PAGE_BACKGROUND_TOKEN));
}

// What one element's background contributes: an opaque hex, a translucent
// overlay to composite, or null (paints nothing / climb). Throws when the
// element paints a background the resolver can't read, so a new idiom fails loud
// instead of asserting against the wrong surface.
function readLayerBackground(element: Element): ResolvedLayer {
  // getAttribute (not `.className`) keeps SVG ancestors, whose className is an
  // SVGAnimatedString, from throwing.
  const classes = element.getAttribute("class") ?? "";
  // A clipped background is foreground ink; climb before reading its style.
  if (CLIPS_TO_TEXT.test(classes)) {
    return null;
  }
  // Inline styles win the cascade, so an inline background decides this layer.
  const inlineBackground = lastBackgroundValue(
    element.getAttribute("style") ?? "",
  );
  if (inlineBackground) {
    return layerFromValue(inlineBackground);
  }
  const opaqueClass = classes.match(OPAQUE_BACKGROUND_CLASS);
  if (opaqueClass) {
    return opaqueClass[1];
  }
  return classBackground(classes);
}

// A token's variant prefix marks it conditional (`hover:`, `dark:`) — it doesn't
// paint the default surface, so it's climbed past rather than read or throwing.
const VARIANT_PREFIXED = /(?:^|\s)[a-z][\w-]*:/;

// Resolve an element's background from its `bg-*` classes. Every token is
// considered, so a non-color utility (`bg-no-repeat`) never masks a real fill
// (`bg-panel`) that follows it. An unconditional token fill wins over a
// same-element overlay (a `hover:` state doesn't change the default surface); a
// translucent overlay composites; an unconditional fill the resolver can't read
// (an unmapped color) fails loud. Conditional fills are climbed past.
function classBackground(classes: string): ResolvedLayer {
  const tokens = classes.match(ALL_BACKGROUND_TOKENS) ?? [];
  const tokenFill = tokens
    .map((token) =>
      VARIANT_PREFIXED.test(token) ? null : backgroundTokenName(token),
    )
    .map((name) => (name ? tokenHex(name) : null))
    .find((hex) => hex !== null);
  if (tokenFill) {
    return tokenFill;
  }
  const overlay = classOverlay(classes);
  if (overlay) {
    return overlay;
  }
  // An unconditional fill that's neither a resolvable color, a non-color utility,
  // nor a translucent overlay is a surface the resolver can't read.
  const unreadable = tokens.filter(
    (token) =>
      !VARIANT_PREFIXED.test(token) &&
      !NON_COLOR_BACKGROUND_CLASS.test(token) &&
      !TRANSLUCENT_BACKGROUND_CLASS.test(token),
  );
  if (unreadable.length) {
    throw new Error(
      `wcag-text-contrast: background class "${unreadable[0].trim()}" this resolver can't read (unmapped color) — teach readLayerBackground the new form`,
    );
  }
  return null;
}

// Climb ancestors to the surface the element renders on: the nearest opaque
// background, compositing any translucent overlays met on the way, or null if
// nothing paints. Recurses so a stack of overlays composites bottom-up.
function climbForBackground(element: Element | null): string | null {
  let ancestor = element;
  while (ancestor) {
    const layer = readLayerBackground(ancestor);
    if (typeof layer === "string") {
      return layer;
    }
    if (layer) {
      const backdrop =
        climbForBackground(ancestor.parentElement) ?? pageBackgroundHex();
      return compositeOver(layer, backdrop);
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
  return climbForBackground(element) ?? pageBackgroundHex();
}

// The unconditional opaque hex ink of an arbitrary `text-[#hex]` class, or null
// when the element sets no such color in its default state. Conditional inks (a
// `dark:`/`hover:` variant, or a `[&…]:` arbitrary-selector one that targets
// something else) are out of scope, like conditional backgrounds — the resolver
// models the default state only. An *unconditional* ink that isn't a clean
// opaque hex (a shorthand, an opacity modifier, an rgb()/var()/named color)
// fails loud so the scan can't silently skip a failing label.
function foregroundHexOf(element: Element): string | null {
  const classes = element.getAttribute("class") ?? "";
  // An element often carries a size `text-[15px]` alongside the color, so scan
  // every arbitrary text value and keep the unconditional color inks.
  const colorInks = [...classes.matchAll(ARBITRARY_TEXT_VALUE)].filter(
    ([, variant, value, opacity]) =>
      !variant && !opacity && !NON_COLOR_TEXT_VALUE.test(value),
  );
  const unreadable = colorInks.find(
    ([, , value]) => !OPAQUE_TEXT_HEX.test(value),
  );
  if (unreadable) {
    throw new Error(
      `wcag-text-contrast: text color "${unreadable[0].trim()}" is a color this scan can't read (shorthand/rgb/var/named) — teach foregroundHexOf the new form`,
    );
  }
  return colorInks.length ? colorInks[0][2] : null;
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
// and asserted against its resolved background. A future hardcoded `text-[#hex]`
// label that fails AA regresses CI here with no hand-written allowlist entry —
// and one on a background the resolver can't read fails loud (see
// readLayerBackground) rather than passing silently. Scope note: this guards the
// `text-[#hex]` idiom issue #38/#65 addressed; text colors set some other way
// (an inline `color:` or a `text-<token>` class) are out of scope here.
// `minHexElements` guards against a broken scan (bad selector, a component that
// stopped rendering its hex labels) silently passing with zero elements found.
// Set below each component's real count so ordinary design churn doesn't trip it
// while a scan that finds nothing still fails.
// `resolvedBackgroundSample` pins one background the scan must resolve, proving
// a path stays exercised in production (NeonPixelsPage's project gradients, read
// off the mounted tree — a fixture can't stand in for Vue's `:style` output).
type HexTextHost = {
  name: string;
  component: typeof NeonPixelsPage | typeof NotFound;
  minHexElements: number;
  resolvedBackgroundSample?: string;
};
const HEX_TEXT_HOSTS: HexTextHost[] = [
  {
    name: "NeonPixelsPage",
    component: NeonPixelsPage,
    minHexElements: 8,
    resolvedBackgroundSample: "#180618",
  },
  { name: "NotFound", component: NotFound, minHexElements: 4 },
];

type ContrastEntry = {
  className: string | null;
  foreground: string;
  background: string;
  ratio: number;
};

function resolvedContrastEntries(root: Element): ContrastEntry[] {
  // querySelectorAll never returns the root itself, so include it explicitly or
  // a hex color on a component's outermost element escapes the scan.
  const candidates = [root, ...root.querySelectorAll('[class*="text-["]')];
  return candidates.flatMap((element) => {
    const foreground = foregroundHexOf(element);
    if (!foreground) {
      return [];
    }
    const background = resolvedBackgroundOf(element);
    return [
      {
        className: element.getAttribute("class"),
        foreground,
        background,
        ratio: contrastRatio(foreground, background),
      },
    ];
  });
}

function belowAA(entry: ContrastEntry): boolean {
  return entry.ratio < WCAG_AA_NORMAL_TEXT;
}

function contrastFailures(root: Element): ContrastEntry[] {
  return resolvedContrastEntries(root).filter(belowAA);
}

describe("arbitrary text-[#hex] elements meet WCAG AA", () => {
  it.each(HEX_TEXT_HOSTS)(
    `every text-[#hex] in $name clears ${WCAG_AA_NORMAL_TEXT}:1 on its resolved background`,
    ({ component, minHexElements, resolvedBackgroundSample }) => {
      const wrapper = mount(component);
      onTestFinished(() => wrapper.unmount());
      const entries = resolvedContrastEntries(wrapper.element);
      expect(entries.length).toBeGreaterThanOrEqual(minHexElements);
      if (resolvedBackgroundSample) {
        expect(entries.map((entry) => entry.background)).toContain(
          resolvedBackgroundSample,
        );
      }
      expect(contrastFailures(wrapper.element)).toEqual([]);
    },
  );
});

// --- Resolver fixtures -----------------------------------------------------
//
// Prove the mechanism the scan relies on: backgrounds resolve to the right
// surface, the ratchet genuinely fails on a low-contrast label, and an
// unreadable painted surface fails loud instead of passing.

function fixtureHost(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

function fixtureLeaf(html: string): Element {
  const leaf = fixtureHost(html).querySelector("[data-leaf]");
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

  it("composites a translucent inline overlay over the surface behind", () => {
    // #08080ae6 (≈90% opaque #08080a) over the panel resolves to ≈#08080a.
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><header style="background: #08080ae6"><span data-leaf class="text-[#f2f2f4]">x</span></header></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#08080a");
  });

  it("composites a translucent overlay class over its backdrop", () => {
    // white at 50% over black is mid-grey — climbing past would report black.
    const leaf = fixtureLeaf(
      '<div class="bg-[#000000]"><span data-leaf class="text-[#ffffff] bg-white/[0.5]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#808080");
  });

  it("reads a token fill even when a state overlay sits beside it", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel hover:bg-white/50"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("reads a token fill a non-color utility sits before", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-no-repeat bg-panel"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("keeps the lightest opaque stop of a gradient that fades to transparent", () => {
    const leaf = fixtureLeaf(
      '<div style="background: linear-gradient(180deg, #2a1030 0%, transparent 100%)"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#2a1030");
  });

  it("prefers background-image over background-color regardless of order", () => {
    const leaf = fixtureLeaf(
      '<div style="background-image: linear-gradient(#0b0b0e, #0b0b0e); background-color: #ffffff"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("falls back to the page background when nothing opaque is painted", () => {
    const leaf = fixtureLeaf(
      '<div><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
  });

  it("reports a text-[#hex] label too dim for its surface as a scan failure", () => {
    const host = fixtureHost(
      '<div class="bg-panel"><span class="text-[#4a4a4a]">x</span></div>',
    );
    const failures = contrastFailures(host);
    expect(failures).toHaveLength(1);
    expect(failures[0].foreground).toBe("#4a4a4a");
  });

  it("reports no failure for a legible text-[#hex] label", () => {
    const host = fixtureHost(
      '<div class="bg-panel"><span class="text-[#a8a8b3]">x</span></div>',
    );
    expect(contrastFailures(host)).toEqual([]);
  });

  it("fails loud on an opaque background it cannot read", () => {
    const leaf = fixtureLeaf(
      '<div style="background: hsl(240, 20%, 8%)"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => resolvedBackgroundOf(leaf)).toThrow(/opaque but unreadable/);
  });

  it("climbs past a child-targeting arbitrary fill (paints no default surface)", () => {
    const leaf = fixtureLeaf(
      '<div class="[&>a]:bg-[#000000]"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
  });

  it("climbs past a conditional fill that paints no default surface", () => {
    const leaf = fixtureLeaf(
      '<div class="hover:bg-panel"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
  });

  it("fails loud on an unmapped opaque color fill", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-rose-500"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => resolvedBackgroundOf(leaf)).toThrow(/can't read/);
  });

  it("resolves a built-in white fill", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-white"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#ffffff");
  });

  it("fails loud on a shorthand arbitrary text color", () => {
    const leaf = fixtureLeaf('<span data-leaf class="text-[#eee]">x</span>');
    expect(() => foregroundHexOf(leaf)).toThrow(/can't read/);
  });

  it("fails loud on a named arbitrary text color", () => {
    const leaf = fixtureLeaf('<span data-leaf class="text-[red]">x</span>');
    expect(() => foregroundHexOf(leaf)).toThrow(/can't read/);
  });

  it("skips a conditional text color (out of scope, default state only)", () => {
    const leaf = fixtureLeaf(
      '<span data-leaf class="dark:text-[#333333]">x</span>',
    );
    expect(foregroundHexOf(leaf)).toBeNull();
  });

  it("skips a child-targeting arbitrary text color", () => {
    const leaf = fixtureLeaf(
      '<span data-leaf class="[&>a]:text-[#333333]">x</span>',
    );
    expect(foregroundHexOf(leaf)).toBeNull();
  });

  it("ignores a non-color arbitrary text value", () => {
    const leaf = fixtureLeaf('<span data-leaf class="text-[15px]">x</span>');
    expect(foregroundHexOf(leaf)).toBeNull();
  });
});
