import { describe, it, expect } from "vitest";
import {
  pageBackgroundHex,
  resolvedBackgroundOf,
  foregroundHexOf,
  panelBackgroundOf,
  readTokenValues,
} from "./background-resolver";

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

  it("reads an opaque inline rgb() background", () => {
    const leaf = fixtureLeaf(
      '<div style="background: rgb(10, 10, 10)"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0a0a0a");
  });

  it.each(["rgba(255, 255, 255, 0.5)", "rgba(255 255 255 / 50%)"])(
    "composites a translucent inline %s over its backdrop",
    (value) => {
      // white at 50% over black is mid-grey, proving both the comma and
      // slash/percent rgba() syntaxes reach the same overlay + alpha.
      const leaf = fixtureLeaf(
        `<div class="bg-[#000000]"><div style="background: ${value}"><span data-leaf class="text-[#f2f2f4]">x</span></div></div>`,
      );
      expect(resolvedBackgroundOf(leaf)).toBe("#808080");
    },
  );

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

  it("composites a whole-number opacity overlay class over its backdrop", () => {
    // Same as the bracket form above, but exercises the numericOpacity branch
    // (`bg-white/50` rather than `bg-white/[0.5]`).
    const leaf = fixtureLeaf(
      '<div class="bg-[#000000]"><span data-leaf class="text-[#ffffff] bg-white/50">x</span></div>',
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

  it.each(["bg-cover", "bg-center", "bg-no-repeat"])(
    "climbs past a lone non-color utility %s instead of failing loud",
    (utility) => {
      const leaf = fixtureLeaf(
        `<div class="${utility}"><span data-leaf class="text-[#f2f2f4]">x</span></div>`,
      );
      expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
    },
  );

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

  it("falls back to background-color when background-image paints nothing", () => {
    const leaf = fixtureLeaf(
      '<div style="background-image: none; background-color: #654321"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#654321");
  });

  it("does not read a custom property's hex value as a painted background", () => {
    // `--card-background` ends in the literal "background", but BACKGROUND_DECLARATION
    // requires a declaration boundary (start or `;`, optionally followed by
    // whitespace) before that word, so the custom property's leading `-` blocks
    // the match and the element still climbs.
    const leaf = fixtureLeaf(
      '<div style="--card-background: #123456"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
  });

  it("reads the real background declaration over a custom property that precedes it", () => {
    const leaf = fixtureLeaf(
      '<div style="--card-background: #123456; background: #654321"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#654321");
  });

  // The fallback color inside a var() call is not necessarily what's
  // painted — the real value comes from the custom property, which this
  // resolver can't read statically. Silently trusting the fallback (a plain
  // hex, an rgba(), one buried inside a nested var() or another function), or
  // trusting a *different* readable stop sitting next to the var() call in
  // the same value, would each be a false pass in the WCAG contrast gate: the
  // property could resolve to something lighter than every stop the resolver
  // can read. Every shape must fail loud instead. (See #95/#101.)
  it.each([
    "var(--card-background)",
    "var(--card-background, #f2f2f4)",
    "var(--card-background, rgba(242, 242, 244, 1))",
    "var(--card-background, var(--panel-background, #f2f2f4))",
    "var(--card-background, linear-gradient(#f2f2f4, rgba(0, 0, 0, 0.5)))",
    "linear-gradient(var(--card-background, #f2f2f4), #0a0a0a)",
    "linear-gradient(var(--card-background), rgba(10, 10, 10, 1))",
  ])(
    "fails loud on background: %s instead of trusting a fallback color",
    (value) => {
      const leaf = fixtureLeaf(
        `<div style="background: ${value}"><span data-leaf class="text-[#f2f2f4]">x</span></div>`,
      );
      expect(() => resolvedBackgroundOf(leaf)).toThrow(/opaque but unreadable/);
    },
  );

  it("fails loud on a var() background-image even beside a readable background-color", () => {
    // background-image wins the image/shorthand-over-color preference (see
    // "prefers background-image over background-color" below), so a var()
    // there must still fail loud rather than falling through to the
    // sibling background-color's readable hex.
    const leaf = fixtureLeaf(
      '<div style="background-image: var(--card-background); background-color: #0a0a0a"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => resolvedBackgroundOf(leaf)).toThrow(/opaque but unreadable/);
  });

  it("fails loud on a var() background-color longhand", () => {
    const leaf = fixtureLeaf(
      '<div style="background-color: var(--card-background, #0a0a0a)"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => resolvedBackgroundOf(leaf)).toThrow(/opaque but unreadable/);
  });

  it("ignores a custom property that follows the real background declaration", () => {
    // lastBackgroundValue takes the *last* declaration match, so the dangerous
    // direction is the custom property coming after the real one: if the
    // `(?:^|;)` boundary were ever loosened, this hits `.at(-1)` and silently
    // reports the custom property's hex instead of the painted surface.
    const leaf = fixtureLeaf(
      '<div style="background: #654321; --card-background: #123456"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#654321");
  });

  it("falls back to the page background when nothing opaque is painted", () => {
    const leaf = fixtureLeaf(
      '<div><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe(pageBackgroundHex());
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

  it("climbs past a background clipped to its own text (foreground ink, not a surface)", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><span data-leaf class="bg-clip-text text-[#f2f2f4]" style="background-image: linear-gradient(#ffffff, #ffffff)">x</span></div>',
    );
    expect(resolvedBackgroundOf(leaf)).toBe("#0b0b0e");
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

  it("resolves the tinted panel surface a label sits on", () => {
    const leaf = fixtureLeaf(
      '<div class="bg-panel"><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(panelBackgroundOf(leaf)).toBe("#0b0b0e");
  });

  it("fails loud when a label has no tinted panel ancestor", () => {
    const leaf = fixtureLeaf(
      '<div><span data-leaf class="text-[#f2f2f4]">x</span></div>',
    );
    expect(() => panelBackgroundOf(leaf)).toThrow(/no tinted panel ancestor/);
  });

  it("fails loud reading a token that isn't declared in style.css", () => {
    expect(() => readTokenValues("--color-does-not-exist")).toThrow(
      /not found in style\.css/,
    );
  });
});
