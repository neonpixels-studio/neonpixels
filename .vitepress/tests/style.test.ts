import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SUPPRESSED_OUTLINE_PATTERN } from "./utils/outlineGuard";

// Anchored to this test file, not process.cwd(), so the read still resolves if
// vitest is invoked from a subdirectory or given a custom root.
const STYLE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../theme/style.css",
  ),
  "utf8",
);

// Comments stripped first so prose can neither satisfy nor mask a match below.
const STYLE_CSS_WITHOUT_COMMENTS = STYLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// happy-dom evaluates neither :focus-visible nor computed CSS, so the WCAG 2.4.7
// keyboard-focus guarantee is asserted against the stylesheet source. This
// guards style.css only: a component <style> setting `outline: none` would
// defeat the global rule and is out of scope here.
const FOCUS_RULE_PATTERN = /:where\(([^)]*)\)\s*:focus-visible\s*\{([^}]*)\}/;
const REQUIRED_FOCUS_TARGETS = ["a", "button", "[tabindex]"];
// A real ring needs a non-zero width + solid style and a non-zero offset; a
// `0`/`none` ring renders nothing, so pin the values, not just the properties.
const VISIBLE_OUTLINE_PATTERN = /outline:\s*[1-9]\d*px\s+solid/;
const OUTLINE_OFFSET_PATTERN = /outline-offset:\s*[1-9]\d*px/;
// SUPPRESSED_OUTLINE_PATTERN (none / 0 / transparent, shorthand or longhand,
// with or without !important) is shared with the component-file guard via
// ./utils/outlineGuard so the global and component checks never drift apart.

function focusRuleMatch() {
  return STYLE_CSS_WITHOUT_COMMENTS.match(FOCUS_RULE_PATTERN);
}

describe("style.css keyboard focus", () => {
  it("defines a global :where(...):focus-visible rule", () => {
    expect(focusRuleMatch()).not.toBeNull();
  });

  it("targets links, buttons and other focusable controls", () => {
    const targets = (focusRuleMatch()?.[1] ?? "")
      .split(",")
      .map((target) => target.trim());
    expect(targets).toEqual(expect.arrayContaining(REQUIRED_FOCUS_TARGETS));
  });

  it("gives the ring a real, non-zero outline lifted off the control", () => {
    const declarations = focusRuleMatch()?.[2] ?? "";
    expect(declarations).toMatch(VISIBLE_OUTLINE_PATTERN);
    expect(declarations).toMatch(OUTLINE_OFFSET_PATTERN);
  });

  it("never suppresses an outline anywhere in the stylesheet", () => {
    expect(STYLE_CSS_WITHOUT_COMMENTS).not.toMatch(SUPPRESSED_OUTLINE_PATTERN);
  });
});

// The `prefers-reduced-motion: reduce` block hand-lists every ambient
// `.animate-*` class it freezes. Nothing ties that list back to the classes
// actually defined above it, so a new `.animate-*` rule (or a renamed one)
// can ship without ever being added there, leaving it looping forever for
// visitors who asked their OS to reduce motion. This parses every rule in the
// stylesheet instead of hand-listing the current seven classes, so the guard
// itself can't go stale the way the CSS did: a class counts as "animated" if
// some rule gives it a real (non-`none`) `animation`/`transition` value, and
// "covered" if some rule sets that same property to `none`. Every animated
// class must also be covered, wherever in the file that happens to live.
type CssRule = { selectors: string[]; body: string };

// Matches one flat `selector(s) { declarations }` block at a time. Nested
// at-rules (`@keyframes`, `@media`) have no selector of their own here, so
// this naturally yields their inner rules (`0%, 18% { ... }`,
// `.animate-drift { animation: none; }`) without needing to special-case the
// wrapper — exactly what this guard needs, since a disabling rule can live
// inside a `@media` block while the animating rule lives outside one.
const CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g;
const ANIMATE_CLASS_PATTERN = /^\.animate-[\w-]+$/;
const MOTION_PROPERTIES = ["animation", "transition"] as const;
const DISABLED_VALUE_PATTERN = /^none\b/i;

function parseCssRules(source: string): CssRule[] {
  return [...source.matchAll(CSS_RULE_PATTERN)].map((match) => ({
    selectors: match[1]
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean),
    body: match[2],
  }));
}

function animateSelectorsOf(rule: CssRule) {
  return rule.selectors.filter((selector) =>
    ANIMATE_CLASS_PATTERN.test(selector),
  );
}

function motionValue(body: string, property: string) {
  const match = body.match(new RegExp(`${property}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

// Files an animate class's motion state for one property into whichever
// bucket applies: a real value means it needs reduced-motion coverage, a
// `none` value means this rule provides that coverage.
function recordMotionState(
  rule: CssRule,
  animateSelectors: string[],
  property: string,
  animatedClasses: Set<string>,
  disabledClasses: Set<string>,
) {
  const value = motionValue(rule.body, property);
  if (value === null) {
    return;
  }
  const targetSet = DISABLED_VALUE_PATTERN.test(value)
    ? disabledClasses
    : animatedClasses;
  animateSelectors.forEach((selector) => targetSet.add(selector));
}

function collectMotionClasses(rules: CssRule[]) {
  const animatedClasses = new Set<string>();
  const disabledClasses = new Set<string>();

  for (const rule of rules) {
    const animateSelectors = animateSelectorsOf(rule);
    if (animateSelectors.length === 0) {
      continue;
    }
    for (const property of MOTION_PROPERTIES) {
      recordMotionState(
        rule,
        animateSelectors,
        property,
        animatedClasses,
        disabledClasses,
      );
    }
  }

  return { animatedClasses, disabledClasses };
}

const { animatedClasses, disabledClasses } = collectMotionClasses(
  parseCssRules(STYLE_CSS_WITHOUT_COMMENTS),
);

describe("style.css reduced-motion coverage", () => {
  it("finds at least one real .animate-* rule to guard", () => {
    // An empty set would make every check below vacuously pass, silently
    // guarding nothing — e.g. if the parser regex stopped matching.
    expect(animatedClasses.size).toBeGreaterThan(0);
  });

  it.each([...animatedClasses])(
    "disables %s inside the prefers-reduced-motion block",
    (animateClass) => {
      expect(disabledClasses.has(animateClass), animateClass).toBe(true);
    },
  );
});
