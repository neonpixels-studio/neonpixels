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
// itself can't go stale the way the CSS did: a class+property counts as
// "animated" if some rule OUTSIDE the reduced-motion block gives it a real
// (non-`none`) value, and "covered" only if some rule INSIDE that exact block
// sets the same property to `none`. Every animated class+property pair must
// also be covered — tracked as a pair, not just a class, so freezing
// `animation` doesn't wrongly excuse a class that only reduces motion via
// `transition` (or vice versa).
type CssRule = { selectorText: string; body: string };

// Matches one flat `selector(s) { declarations }` block at a time. Nested
// at-rules (`@keyframes`, `@media`) have no selector of their own here, so
// this naturally yields their inner rules (`0%, 18% { ... }`,
// `.animate-drift { animation: none; }`) without needing to special-case the
// wrapper.
const CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g;
// A bare token scan (not an exact selector match) so a class is still caught
// under a pseudo-element or descendant combinator, e.g. `.animate-drift:hover`
// or `.hero .animate-drift`, not just a plain `.animate-drift` selector.
const ANIMATE_CLASS_TOKEN_PATTERN = /\.animate-[\w-]+/g;
const MOTION_PROPERTIES = ["animation", "transition"] as const;
const DISABLED_VALUE_PATTERN = /^none\b/i;
// Matches the `@media (...) {` opener for any reduced-motion query, not one
// exact spelling — tolerant of extra media features (`screen and ...`) and
// of whitespace around the colon, so a harmless reformat of the query can't
// make this guard stop finding the block it exists to check.
const REDUCED_MOTION_QUERY_OPENER =
  /@media[^{]*\bprefers-reduced-motion\s*:\s*reduce\b[^{]*\{/gi;
// Joins a class token and a motion property into one map key so `animation`
// coverage can never stand in for `transition` coverage or vice versa.
const KEY_SEPARATOR = "::";

function parseCssRules(source: string): CssRule[] {
  return [...source.matchAll(CSS_RULE_PATTERN)].map((match) => ({
    selectorText: match[1],
    body: match[2],
  }));
}

function extractAnimateClasses(selectorText: string) {
  return [...selectorText.matchAll(ANIMATE_CLASS_TOKEN_PATTERN)].map(
    (match) => match[0],
  );
}

// Returns the LAST declared value for `property` in `body` (CSS applies the
// last declaration when a property repeats), and matches through to the
// closing brace so a final declaration missing its trailing `;` still counts.
// The `(?:^|[;\s])` guard stops `-webkit-animation`/`--animation` custom
// properties from being read as a plain `animation` declaration. Named for
// the property it reads generically, not just motion ones — the
// forced-colors coverage suite below reuses it for `display`/`border`/
// `color`/etc.
function lastDeclarationValue(body: string, property: string) {
  const declarationPattern = new RegExp(
    `(?:^|[;\\s])${property}:\\s*([^;}]+)`,
    "gi",
  );
  const matches = [...body.matchAll(declarationPattern)];
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1][1].trim();
}

// Finds the `}` that closes the brace opened at `openBraceIndex`, so a block
// can be sliced out whole even though it wraps more than one nested rule.
// `blockName` only flavors the "unbalanced braces" error so a caller scanning
// a different block (e.g. forced-colors) doesn't get a misleading message
// naming the reduced-motion block.
function findMatchingBraceIndex(
  source: string,
  openBraceIndex: number,
  blockName: string,
) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    if (depth === 0) {
      return index;
    }
  }
  throw new Error(
    `Unbalanced braces while scanning for the ${blockName} block`,
  );
}

// Splits the stylesheet into the reduced-motion block(s)' own bodies
// (candidate "coverage" rules) and everything else (candidate "animated"
// rules), so a `.animate-x { animation: none }` written for an unrelated
// reason elsewhere in the file can never masquerade as reduced-motion
// coverage. Handles more than one matching `@media` block (nothing stops a
// future edit from adding a second, e.g. scoped to one component's <style>)
// by cutting each one out right-to-left, which keeps every earlier match's
// index valid as later slices are removed.
function splitReducedMotionBlock(source: string) {
  const queryMatches = [...source.matchAll(REDUCED_MOTION_QUERY_OPENER)];
  if (queryMatches.length === 0) {
    // Fail loud: a query that can no longer be found must not be silently
    // treated as "nothing to cover" — that would make every animated class
    // pass this guard for the wrong reason.
    throw new Error(
      "style.css has no @media (prefers-reduced-motion: reduce) block to check coverage against",
    );
  }

  const insideBlocks: string[] = [];
  let outsideBlock = source;
  [...queryMatches].reverse().forEach((match) => {
    const openBraceIndex = match.index + match[0].length - 1;
    const closeBraceIndex = findMatchingBraceIndex(
      outsideBlock,
      openBraceIndex,
      "prefers-reduced-motion",
    );
    insideBlocks.unshift(
      outsideBlock.slice(openBraceIndex + 1, closeBraceIndex),
    );
    outsideBlock =
      outsideBlock.slice(0, match.index) +
      outsideBlock.slice(closeBraceIndex + 1);
  });

  return { insideBlock: insideBlocks.join("\n"), outsideBlock };
}

// Adds one class+property pair per class in `animateClasses` to `destination`,
// but only if `value`'s disabled-state matches `wantDisabled` (false while
// scanning outside the block for real animations, true while scanning inside
// it for `none` overrides).
function recordMotionPair(
  animateClasses: string[],
  property: string,
  wantDisabled: boolean,
  value: string,
  destination: Set<string>,
) {
  if (DISABLED_VALUE_PATTERN.test(value) !== wantDisabled) {
    return;
  }
  animateClasses.forEach((selector) =>
    destination.add(`${selector}${KEY_SEPARATOR}${property}`),
  );
}

function collectMotionClassesFromRule(
  rule: CssRule,
  wantDisabled: boolean,
  destination: Set<string>,
) {
  const animateClasses = extractAnimateClasses(rule.selectorText);
  if (animateClasses.length === 0) {
    return;
  }
  MOTION_PROPERTIES.forEach((property) => {
    const value = lastDeclarationValue(rule.body, property);
    if (value === null) {
      return;
    }
    recordMotionPair(
      animateClasses,
      property,
      wantDisabled,
      value,
      destination,
    );
  });
}

function collectMotionClasses(source: string) {
  const { insideBlock, outsideBlock } = splitReducedMotionBlock(source);
  const animatedClasses = new Set<string>();
  const disabledClasses = new Set<string>();

  parseCssRules(outsideBlock).forEach((rule) =>
    collectMotionClassesFromRule(rule, false, animatedClasses),
  );
  parseCssRules(insideBlock).forEach((rule) =>
    collectMotionClassesFromRule(rule, true, disabledClasses),
  );

  return { animatedClasses, disabledClasses };
}

// Computed once, at module scope, so every `it`/`it.each` below shares the
// same parse — but caught rather than left to throw here: an uncaught throw
// during module evaluation would abort collection of this whole file (taking
// the unrelated `style.css keyboard focus` suite above down with it) instead
// of failing as one named, attributable test.
let reducedMotionSplitError: Error | null = null;
let animatedClasses = new Set<string>();
let disabledClasses = new Set<string>();
try {
  ({ animatedClasses, disabledClasses } = collectMotionClasses(
    STYLE_CSS_WITHOUT_COMMENTS,
  ));
} catch (error) {
  reducedMotionSplitError =
    error instanceof Error ? error : new Error(String(error));
}
// An independent, dumber scan of every `.animate-*` token anywhere in the
// file. If `collectMotionClasses`'s rule parser ever silently stops matching
// (a regex tweak gone wrong, an unexpected syntax shape), the tests below
// would otherwise still pass on whatever shrunken set it did find — this
// pins the parser's own coverage against ground truth so that failure mode
// can't hide.
const ALL_ANIMATE_CLASS_TOKENS = new Set(
  extractAnimateClasses(STYLE_CSS_WITHOUT_COMMENTS),
);

function baseSelectorOf(key: string) {
  return key.split(KEY_SEPARATOR)[0];
}

describe("style.css reduced-motion coverage", () => {
  it("parses a @media (prefers-reduced-motion: reduce) block without error", () => {
    expect(reducedMotionSplitError).toBeNull();
  });

  it("finds at least one real .animate-* rule to guard", () => {
    // An empty set would make every check below vacuously pass, silently
    // guarding nothing — e.g. if the parser regex stopped matching.
    expect(animatedClasses.size).toBeGreaterThan(0);
  });

  it("accounts for every .animate-* class token found anywhere in the file", () => {
    const classesTheParserSaw = new Set(
      [...animatedClasses, ...disabledClasses].map(baseSelectorOf),
    );
    expect(classesTheParserSaw).toEqual(ALL_ANIMATE_CLASS_TOKENS);
  });

  const animatedEntries = [...animatedClasses].map((key) => {
    const [selector, property] = key.split(KEY_SEPARATOR);
    return { key, selector, property };
  });

  it.each(animatedEntries)(
    "disables $selector's $property inside the prefers-reduced-motion block",
    ({ key }) => {
      expect(disabledClasses.has(key), key).toBe(true);
    },
  );
});

// The `forced-colors: active` block (Windows High Contrast Mode) restyles the
// ambient decoration, gradient wordmark text, color-only indicator dots, and
// the Wanderist trip-log heatmap that would otherwise render uncontrolled,
// vanish, or paint with no visible fill once the OS takes over the palette.
// Matched by its @media opener, then sliced out via `findMatchingBraceIndex`
// so a naive regex can't be fooled by nested rules — happy-dom evaluates
// neither the media feature nor computed CSS, so this asserts against the
// stylesheet source, same as the focus-ring guard at the top of this file.
//
// Each check below parses the block into rules with `parseCssRules` and reads
// declarations with `lastDeclarationValue` (both defined above for the
// reduced-motion suite) rather than regex-matching a hand-written selector
// list in a fixed order: a `color:` match, for instance, must not also accept
// `-webkit-text-fill-color:` just because the substring appears inside it,
// and a future edit that splits `.animate-aurora` and `.animate-drift` into
// separate rules (or reorders them) must not fail this suite for a reason
// that isn't a real regression.
const FORCED_COLORS_QUERY_OPENER =
  /@media[^{]*\bforced-colors\s*:\s*active\b[^{]*\{/i;

function extractForcedColorsBlock(source: string): string {
  const match = source.match(FORCED_COLORS_QUERY_OPENER);
  if (!match || match.index === undefined) {
    // Fail loud, same as splitReducedMotionBlock: a query that can no longer
    // be found must not be silently treated as "nothing to cover".
    throw new Error(
      "style.css has no @media (forced-colors: active) block to check coverage against",
    );
  }
  const openBraceIndex = match.index + match[0].length - 1;
  const closeBraceIndex = findMatchingBraceIndex(
    source,
    openBraceIndex,
    "forced-colors",
  );
  return source.slice(openBraceIndex + 1, closeBraceIndex);
}

// Computed once, at module scope, and caught rather than left to throw during
// collection — same reasoning as reducedMotionSplitError above: an uncaught
// throw here would abort this whole file, taking the unrelated suites above
// down with it instead of failing as one named, attributable test.
let forcedColorsBlockError: Error | null = null;
let forcedColorsBlockBody: string | null = null;
try {
  forcedColorsBlockBody = extractForcedColorsBlock(STYLE_CSS_WITHOUT_COMMENTS);
} catch (error) {
  forcedColorsBlockError =
    error instanceof Error ? error : new Error(String(error));
}
const forcedColorsRules = parseCssRules(forcedColorsBlockBody ?? "");

// True if some rule in the forced-colors block targets `className` (as a
// whole class token, so `.pill` can't false-match `.pill-dot`) and declares
// `property` to a value matching `expectedValue`.
function forcedColorsBlockDeclares(
  className: string,
  property: string,
  expectedValue: RegExp,
) {
  const classPattern = new RegExp(`\\.${className}\\b`);
  return forcedColorsRules.some((rule) => {
    if (!classPattern.test(rule.selectorText)) {
      return false;
    }
    const value = lastDeclarationValue(rule.body, property);
    return value !== null && expectedValue.test(value);
  });
}

describe("style.css forced-colors coverage", () => {
  it("parses a @media (forced-colors: active) block without error", () => {
    expect(forcedColorsBlockError).toBeNull();
  });

  it("defines a @media (forced-colors: active) block", () => {
    expect(forcedColorsBlockBody).not.toBeNull();
  });

  it.each(["animate-drift", "animate-aurora", "animate-aurora-reverse"])(
    "hides %s instead of letting it render in whatever color an engine that doesn't null gradient backgrounds leaves it",
    (className) => {
      expect(forcedColorsBlockDeclares(className, "display", /^none\b/i)).toBe(
        true,
      );
    },
  );

  it("gives gradient-clipped wordmark text a real, non-transparent fill", () => {
    expect(
      forcedColorsBlockDeclares("bg-clip-text", "color", /^CanvasText\b/i),
    ).toBe(true);
    expect(
      forcedColorsBlockDeclares(
        "bg-clip-text",
        "-webkit-text-fill-color",
        /^CanvasText\b/i,
      ),
    ).toBe(true);
  });

  it.each(["animate-pulse-dot", "pill-dot"])(
    "gives %s a system-color border so it can't vanish into Canvas",
    (className) => {
      expect(
        forcedColorsBlockDeclares(
          className,
          "border",
          /^1px solid CanvasText\b/i,
        ),
      ).toBe(true);
    },
  );

  it("borders every trip-log cell in a system color", () => {
    expect(
      forcedColorsBlockDeclares(
        "trip-cell",
        "border",
        /^1px solid CanvasText\b/i,
      ),
    ).toBe(true);
  });

  it("fills visited trip-log cells so the visited/unvisited distinction survives", () => {
    const visitedRule = forcedColorsRules.find((rule) =>
      /\.trip-cell\[data-visited="true"\]/.test(rule.selectorText),
    );
    expect(visitedRule).not.toBeUndefined();
    expect(lastDeclarationValue(visitedRule?.body ?? "", "background")).toMatch(
      /^CanvasText\b/i,
    );
  });
});
