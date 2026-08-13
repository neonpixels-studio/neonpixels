import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Anchored to this test file, not process.cwd(), so the read still resolves if
// vitest is invoked from a subdirectory or given a custom root.
const STYLE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../theme/style.css",
  ),
  "utf8",
);

// happy-dom evaluates neither `:focus-visible` nor computed CSS, so the keyboard
// focus guarantee (WCAG 2.4.7) is asserted against the stylesheet source: the
// custom dark theme owns the whole page, so a single global rule is what gives
// every link/button a visible focus ring.
const FOCUS_RULE_PATTERN = /([^{}]*):focus-visible\s*\{([^}]*)\}/;
// The exact regressions this guards: an accidental `outline: none`/`outline: 0`
// that silently strips the ring keyboard users rely on.
const SUPPRESSED_OUTLINE_PATTERN = /outline:\s*(none|0)\b/;

describe("style.css keyboard focus", () => {
  it("defines a global :focus-visible rule", () => {
    expect(STYLE_CSS).toMatch(FOCUS_RULE_PATTERN);
  });

  it("targets links, buttons and other focusable controls, not one class", () => {
    const selector = STYLE_CSS.match(FOCUS_RULE_PATTERN)?.[1] ?? "";
    expect(selector).toContain("a");
    expect(selector).toContain("button");
    expect(selector).toContain("tabindex");
  });

  it("gives the ring a real outline lifted off the control, never suppressed", () => {
    const declarations = STYLE_CSS.match(FOCUS_RULE_PATTERN)?.[2] ?? "";
    // A visible ring needs a solid outline plus an offset lifting it onto the
    // dark page; assert the value, not just the property, so `outline: none`
    // (or an offset-less ring) can't pass this green.
    expect(declarations).toMatch(/outline:\s*\S+\s+solid/);
    expect(declarations).not.toMatch(SUPPRESSED_OUTLINE_PATTERN);
    expect(declarations).toMatch(/outline-offset:/);
  });
});
