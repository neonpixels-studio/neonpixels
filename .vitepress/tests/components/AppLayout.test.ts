import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, shallowMount, enableAutoUnmount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TABBABLE_SELECTOR } from "../utils/tabbable";
import { stripComments } from "../utils/outlineGuard";

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
// Reset in beforeEach so it's order-independent: an afterEach scrub races the
// auto-unmount hook (reverse registration order), but beforeEach always runs
// before the next mount regardless of hook sequencing.
beforeEach(() => {
  pageState.isNotFound = false;
  document.body.innerHTML = "";
});
afterEach(() => {
  // Restore any console spy here, so a failing assertion mid-test can't leave
  // console.warn stubbed for the tests that follow.
  vi.restoreAllMocks();
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
      // <main> is not natively focusable — without tabindex="-1" the view sets,
      // landmark.focus() is a no-op in a real browser (happy-dom focuses it
      // regardless, so pin the attribute here or the bypass silently dies).
      expect(main.attributes("tabindex")).toBe("-1");
      await wrapper.get("a.skip-link").trigger("click");
      expect(document.activeElement).toBe(main.element);
    },
  );

  it("warns and moves no focus when the route exposes no landmark", async () => {
    // Exercises the fail-loud guard so it can't be deleted or inverted with the
    // suite still green: stub the view to a fragment with no <main>, so
    // getElementById(MAIN_CONTENT_ID) misses. afterEach restores the spy even if
    // an assertion below throws.
    pageState.isNotFound = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(AppLayout, {
      attachTo: document.body,
      global: {
        stubs: { NeonPixelsPage: { template: "<div>no landmark here</div>" } },
      },
    });
    // Put focus on the link like a real keyboard user would before activating,
    // so the post-click assertion is non-trivial: the guard must not steal or
    // drop focus (asserting activeElement stays on document.body would pass for
    // a handler that focuses nothing at all).
    const skipLink = wrapper.get("a.skip-link");
    skipLink.element.focus();
    expect(document.activeElement).toBe(skipLink.element);
    await skipLink.trigger("click");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(MAIN_CONTENT_ID));
    expect(document.activeElement).toBe(skipLink.element);
  });

  it("hides the skip link off-canvas until it is focused", () => {
    // Guards the reveal mechanism from silent deletion. position: fixed takes it
    // out of flow; the transform lifts it above the viewport, restored to
    // translateY(0) on :focus; z-index clears the sticky header (z-30) so the
    // revealed chip isn't buried; the reduced-motion rule drops the transition.
    // The rules are `scoped`, so also assert the rendered link actually carries
    // AppLayout's OWN scope id — a plain data-v-* check would still pass if the
    // link moved into a child SFC (which stamps its own scope id) while these
    // CSS rules stayed orphaned in AppLayout, styling nothing.
    const wrapper = mount(AppLayout);
    const scopeId = (AppLayout as unknown as { __scopeId?: string }).__scopeId;
    expect(scopeId).toBeTruthy();
    expect(Object.keys(wrapper.get("a.skip-link").attributes())).toContain(
      scopeId,
    );
    // Strip comments first: a commented-out style block would otherwise leave
    // every regex below matching dead text while the link renders permanently
    // visible.
    const layoutSource = stripComments(readFileSync(LAYOUT_PATH, "utf8"));
    expect(layoutSource).toMatch(/\.skip-link\s*\{[^}]*position:\s*fixed/);
    // The link renders outside NeonPixelsPage's .font-mono root, so it must set
    // the monospace face itself or fall back to the default sans stack.
    expect(layoutSource).toMatch(
      /\.skip-link\s*\{[^}]*font-family:\s*var\(--font-mono\)/,
    );
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
