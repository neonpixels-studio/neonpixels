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
