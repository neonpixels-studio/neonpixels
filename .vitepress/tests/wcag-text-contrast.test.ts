import { describe, it, expect, onTestFinished } from "vitest";
import { mount } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import NotFound from "@components/NotFound.vue";
import { contrastRatio } from "@theme/utils/color";
import {
  PAGE_BACKGROUND_TOKEN,
  readTokenValues,
  resolvedBackgroundOf,
  panelBackgroundOf,
  foregroundHexOf,
} from "./helpers/background-resolver";

// WCAG 2.1 SC 1.4.3: normal-size body text needs at least this ratio. Every
// token and arbitrary hex under test renders at normal weight/size (never
// large/bold), so the 3:1 large-text allowance does not apply.
const WCAG_AA_NORMAL_TEXT = 4.5;

const MUTED_TEXT_TOKENS = [
  "--color-fg-faint",
  "--color-fg-dim",
  "--color-fg-subtle",
  "--color-fg-muted",
];

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
        readTokenValues(PAGE_BACKGROUND_TOKEN),
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );
});

// Background/foreground resolution (the CSS-surface resolver that climbs an
// element's ancestors for the opaque background it renders on) lives in
// helpers/background-resolver.ts, with its own fixture-driven unit tests in
// helpers/background-resolver.test.ts. This file consumes it to build the
// higher-level assertions below.

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

function fixtureHost(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

// These two prove the ratchet mechanism itself (resolver + contrastRatio
// scoring together) actually flags a low-contrast label and passes a legible
// one. The resolver's own behavior (background/foreground resolution in
// isolation) is unit-tested against fixtures in
// helpers/background-resolver.test.ts.
describe("arbitrary text-[#hex] ratchet mechanics", () => {
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
});
