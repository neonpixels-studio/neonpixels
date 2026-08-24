import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, shallowMount, enableAutoUnmount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TABBABLE_SELECTOR } from "../utils/tabbable";

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

// AppLayout is a multi-root (fragment) component and several tests attach it to
// document.body to exercise real focus/Tab order. Unmount every wrapper and
// scrub the body + shared page state between tests so an attached tree from one
// case can't leak a stale #main-content into the next (skipToContent resolves
// the landmark document-wide by id).
enableAutoUnmount(afterEach);
afterEach(() => {
  pageState.isNotFound = false;
  document.body.innerHTML = "";
});

describe("AppLayout", () => {
  it("renders the homepage for a valid route", () => {
    pageState.isNotFound = false;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      true,
    );
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(false);
  });

  it("renders the 404 view when the page is not found", () => {
    pageState.isNotFound = true;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      false,
    );
  });

  // Full-mount (not shallowMount) so a skip link mistakenly re-added inside a
  // child view would be counted here — the whole point of hoisting it is that
  // exactly one exists per rendered route, so assert that on both routes.
  it.each([
    ["homepage", false],
    ["404 view", true],
  ])(
    "renders exactly one skip link targeting the shared landmark on the %s",
    (_label, isNotFound) => {
      pageState.isNotFound = isNotFound;
      const wrapper = mount(AppLayout);
      const skipLinks = wrapper.findAll("a.skip-link");
      expect(skipLinks).toHaveLength(1);
      expect(skipLinks[0].attributes("href")).toBe(`#${MAIN_CONTENT_ID}`);
    },
  );

  // Bypass-blocks only works if the skip link is the first Tab stop, so it must
  // precede every other tabbable control in true document order. VTU's findAll
  // hoists matching fragment root nodes to the front, masking order — query the
  // attached DOM directly so a control slipped in above the link would fail.
  it.each([
    ["homepage", false],
    ["404 view", true],
  ])(
    "makes the skip link the first tabbable element on the %s",
    (_label, isNotFound) => {
      pageState.isNotFound = isNotFound;
      mount(AppLayout, { attachTo: document.body });
      const tabbables = Array.from(
        document.body.querySelectorAll(TABBABLE_SELECTOR),
      );
      expect(tabbables.length).toBeGreaterThan(0);
      expect(tabbables[0]).toBe(document.querySelector("a.skip-link"));
    },
  );

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
