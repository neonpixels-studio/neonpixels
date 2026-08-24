import { describe, it, expect, vi } from "vitest";
import { mount, shallowMount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pageState = vi.hoisted(() => ({ isNotFound: false }));

vi.mock("vitepress", async () => {
  const { computed } = await import("vue");
  return {
    useData: () => ({
      page: computed(() => ({ isNotFound: pageState.isNotFound })),
    }),
  };
});

import AppLayout from "@theme/AppLayout.vue";
import { MAIN_CONTENT_ID } from "@theme/a11y";

// happy-dom evaluates no computed CSS, so the skip link's "hidden until focused"
// styling can't be asserted on the mounted DOM — scan the layout source instead
// (as component-focus.test.ts does for the outline guard). Anchored to this test
// file so it resolves however vitest is invoked.
const LAYOUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../theme/AppLayout.vue",
);

// Tabbable-element selector: excludes disabled controls and negative-tabindex
// elements (our own <main>) so they don't masquerade as a Tab stop.
const TABBABLE_SELECTOR =
  'a[href]:not([tabindex^="-"]), area[href]:not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), input:not([disabled]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), iframe:not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';

describe("AppLayout", () => {
  it("renders the homepage for a valid route", () => {
    pageState.isNotFound = false;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      true,
    );
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the 404 view when the page is not found", () => {
    pageState.isNotFound = true;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      false,
    );
    wrapper.unmount();
  });

  it("renders one skip link pointing at the shared content landmark", () => {
    pageState.isNotFound = false;
    const wrapper = shallowMount(AppLayout);
    const skipLinks = wrapper.findAll("a.skip-link");
    // Exactly one: the skip link is hoisted here so both views share a single
    // implementation, not zero (no bypass) or a duplicate per view.
    expect(skipLinks).toHaveLength(1);
    expect(skipLinks[0].attributes("href")).toBe(`#${MAIN_CONTENT_ID}`);
    wrapper.unmount();
  });

  it("makes the skip link the first tabbable element on the page", () => {
    pageState.isNotFound = false;
    // Bypass-blocks only works if the skip link is reached first on Tab, so it
    // must precede every other tabbable control in document order — full-mount
    // so the child view's real controls (header nav, CTAs) are present to
    // compete for the first stop.
    const wrapper = mount(AppLayout);
    const tabbables = wrapper.findAll(TABBABLE_SELECTOR);
    expect(tabbables.length).toBeGreaterThan(1);
    expect(tabbables[0].classes()).toContain("skip-link");
    wrapper.unmount();
  });

  // The real WCAG 2.4.1 guarantee, asserted on BOTH routes: activating the skip
  // link must land focus on that route's <main> (VitePress's router only scrolls
  // hash links, so the layout moves focus itself). attachTo connects the tree so
  // focus() actually takes, and getElementById resolves the child-rendered main.
  it.each([
    ["homepage", false],
    ["404 view", true],
  ])(
    "moves focus into the main landmark on the %s",
    async (_label, isNotFound) => {
      pageState.isNotFound = isNotFound;
      const wrapper = mount(AppLayout, { attachTo: document.body });
      await wrapper.vm.$nextTick();
      const main = wrapper.get("main");
      expect(main.attributes("id")).toBe(MAIN_CONTENT_ID);
      await wrapper.get("a.skip-link").trigger("click");
      expect(document.activeElement).toBe(main.element);
      wrapper.unmount();
    },
  );

  it("hides the skip link off-canvas until it is focused", () => {
    // Guards the reveal mechanism from silent deletion. position: fixed takes it
    // out of flow; the transform lifts it above the viewport, restored to
    // translateY(0) on :focus; z-index clears the sticky header (z-30) so the
    // revealed chip isn't buried; the reduced-motion rule drops the transition.
    const layoutSource = readFileSync(LAYOUT_PATH, "utf8");
    expect(layoutSource).toMatch(/\.skip-link\s*\{[^}]*position:\s*fixed/);
    expect(layoutSource).toMatch(
      /\.skip-link\s*\{[^}]*z-index:\s*(?:[4-9]\d|\d{3,})/,
    );
    expect(layoutSource).toMatch(
      /\.skip-link\s*\{[^}]*transform:\s*translateY\(-/,
    );
    expect(layoutSource).toMatch(
      /\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(0/,
    );
    expect(layoutSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skip-link\s*\{[^}]*transition:\s*none/,
    );
  });
});
