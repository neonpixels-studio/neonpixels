import { describe, it, expect } from "vitest";
import {
  SUPPRESSED_OUTLINE_PATTERN,
  OUTLINE_UTILITY_PATTERN,
  stripComments,
} from "./outlineGuard";

// The file-scanning guards (style.test.ts, component-focus.test.ts) run against
// real files that currently pass, so they can't prove the patterns still bite.
// These fixtures pin the matching logic itself: a regression that neuters a
// pattern (or stripComments) fails here even while every real file is clean.

describe("SUPPRESSED_OUTLINE_PATTERN", () => {
  const suppressions = [
    "outline: none;",
    "outline:0;",
    "outline: 0px;",
    "outline: transparent;",
    "outline-width: 0 !important;",
    "outline-style:none}",
    'style="outline:none"',
  ];
  it.each(suppressions)("flags %j", (declaration) => {
    expect(declaration).toMatch(SUPPRESSED_OUTLINE_PATTERN);
  });

  const allowed = [
    "outline: 2px solid var(--color-lime);",
    "outline: 2px solid transparent;", // a real 2px ring; only a bare `outline: transparent` is a suppression
    ".cta-outline:hover {", // a selector containing "outline", not an `outline:` declaration
  ];
  it.each(allowed)("allows %j", (declaration) => {
    expect(declaration).not.toMatch(SUPPRESSED_OUTLINE_PATTERN);
  });
});

describe("OUTLINE_UTILITY_PATTERN", () => {
  const hiders = [
    "outline-none",
    "focus:outline-none",
    "focus-visible:outline-none",
    "outline-hidden",
    "focus:outline-hidden",
  ];
  it.each(hiders)("flags %j", (utility) => {
    expect(utility).toMatch(OUTLINE_UTILITY_PATTERN);
  });

  const allowed = ["outline-2", "outline-offset-2", "cta-outline"];
  it.each(allowed)("allows %j", (utility) => {
    expect(utility).not.toMatch(OUTLINE_UTILITY_PATTERN);
  });
});

describe("stripComments", () => {
  it("removes CSS block, HTML, and JS line comments", () => {
    const source = [
      "/* outline: none; */",
      "<!-- outline-none -->",
      "// focus:outline-none",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toMatch(SUPPRESSED_OUTLINE_PATTERN);
    expect(stripped).not.toMatch(OUTLINE_UTILITY_PATTERN);
  });

  it("preserves protocol and protocol-relative URLs", () => {
    const source = 'const href = "https://x.dev";\nbackground: url(//cdn.x/y);';
    const stripped = stripComments(source);
    expect(stripped).toContain("https://x.dev");
    expect(stripped).toContain("url(//cdn.x/y)");
  });

  it("keeps a real declaration that trails a protocol-relative URL on its line", () => {
    const source = 'src="//cdn.x/a"; outline: none;';
    expect(stripComments(source)).toMatch(SUPPRESSED_OUTLINE_PATTERN);
  });
});
