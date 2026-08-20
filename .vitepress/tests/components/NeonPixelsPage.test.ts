import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";

// happy-dom evaluates no computed CSS, so the skip link's "hidden until focused"
// styling can't be asserted on the mounted DOM — scan the component source
// instead (as component-focus.test.ts does for the outline guard). Anchored to
// this test file so it resolves however vitest is invoked. Read lazily inside
// the one test that needs it, so a moved file fails that assertion rather than
// crashing every test in the suite at import time.
const COMPONENT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../theme/components/NeonPixelsPage.vue",
);

// Interactive control classes the global :focus-visible ring lands on.
const INTERACTIVE_FOCUS_CLASSES = ["pill", "nav-link", "footer-link"];

// Matches any absolute URL (has a scheme) or a protocol-relative URL. In-page
// hash links (#top, #projects) are internal and must NOT open a new tab.
const EXTERNAL_HREF_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function isExternalHref(href: string) {
  return EXTERNAL_HREF_PATTERN.test(href);
}

// The four projects each get an external CTA and an external footer link.
const PROJECT_URLS = [
  "https://grimicorn.dev",
  "https://wanderist.io",
  "https://basin.fm",
  "https://markpost.io",
];

const PROJECT_SECTION_IDS = ["grimicorn", "wanderist", "basin", "markpost"];

describe("NeonPixelsPage", () => {
  it("renders correctly", () => {
    const wrapper = mount(NeonPixelsPage);
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("exposes a single main landmark that the skip link targets", () => {
    const wrapper = mount(NeonPixelsPage);
    // Exactly one primary landmark: assistive tech should find a single <main>,
    // not zero (no bypass target) or several (ambiguous).
    const landmarks = wrapper.findAll("main");
    expect(landmarks).toHaveLength(1);
    const mainId = landmarks[0].attributes("id");
    expect(mainId).toBeTruthy();
    // Without tabindex="-1" the skip link can't move focus into <main> on
    // browsers that don't honor fragment-nav focus (Safari), so the bypass is
    // cosmetic. Pin the attribute here.
    expect(landmarks[0].attributes("tabindex")).toBe("-1");
    // The skip link is the WCAG 2.4.1 bypass mechanism: it must jump to that id.
    const skipLink = wrapper.get("a.skip-link");
    expect(skipLink.attributes("href")).toBe(`#${mainId}`);
    wrapper.unmount();
  });

  it("makes the skip link the first tabbable element in the page component", () => {
    const wrapper = mount(NeonPixelsPage);
    // Bypass-blocks only works if the skip link is reached first on Tab, so it
    // must precede every other tabbable control in this component's document
    // order — assert against the tabbable set, not just anchors, so a header
    // button or a [tabindex] element slipped in above it would fail here.
    // Exclude the not-tabbable cases (disabled controls, negative tabindex like
    // our own <main>) so they don't masquerade as the first stop. Scope is this
    // component; the theme layout renders it as the whole page body (VitePress's
    // own nav chrome is display:none), so first-here is first on the page.
    const tabbables = wrapper.findAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable], [tabindex]:not([tabindex^="-"])',
    );
    expect(tabbables.length).toBeGreaterThan(0);
    expect(tabbables[0].classes()).toContain("skip-link");
    wrapper.unmount();
  });

  it("moves focus into the main landmark when the skip link is activated", async () => {
    // The real WCAG 2.4.1 guarantee: activating the skip link must land focus on
    // <main> (VitePress's router only scrolls hash links, so the component moves
    // focus itself). attachTo connects the tree so focus() actually takes.
    const wrapper = mount(NeonPixelsPage, { attachTo: document.body });
    await wrapper.get("a.skip-link").trigger("click");
    expect(document.activeElement).toBe(wrapper.get("main").element);
    wrapper.unmount();
  });

  it("hides the skip link off-canvas until it is focused", () => {
    // Guards the reveal mechanism from silent deletion. position: fixed takes it
    // out of flow (without it the link is an in-flow box shoving the hero down);
    // the transform lifts it above the viewport, restored to translateY(0) on
    // :focus; z-index clears the sticky header (z-30) so the revealed chip isn't
    // buried behind it; the reduced-motion rule drops the transition. Together
    // that's the whole hide/show contract.
    const componentSource = readFileSync(COMPONENT_PATH, "utf8");
    expect(componentSource).toMatch(/\.skip-link\s*\{[^}]*position:\s*fixed/);
    expect(componentSource).toMatch(
      /\.skip-link\s*\{[^}]*z-index:\s*(?:[4-9]\d|\d{3,})/,
    );
    expect(componentSource).toMatch(
      /\.skip-link\s*\{[^}]*transform:\s*translateY\(-/,
    );
    expect(componentSource).toMatch(
      /\.skip-link:focus\s*\{[^}]*transform:\s*translateY\(0/,
    );
    expect(componentSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skip-link\s*\{[^}]*transition:\s*none/,
    );
  });

  it("renders the hero headline", () => {
    const wrapper = mount(NeonPixelsPage);
    const heading = wrapper.find("h1").text();
    expect(heading).toContain("WE BUILD THE");
    expect(heading).toContain("MISSING APPS");
    wrapper.unmount();
  });

  it("renders a section for each of the four projects", () => {
    const wrapper = mount(NeonPixelsPage);
    PROJECT_SECTION_IDS.forEach((id) => {
      expect(wrapper.find(`section#${id}`).exists()).toBe(true);
    });
    wrapper.unmount();
  });

  it("renders both a summary and a bespoke visual in every section", () => {
    const wrapper = mount(NeonPixelsPage);
    // A section with no matching #visual branch would leave the grid with only
    // the summary column; assert both columns are present so a project added
    // without a visual fails here instead of shipping a half-empty section.
    PROJECT_SECTION_IDS.forEach((id) => {
      const grid = wrapper.get(`section#${id} .grid`);
      expect(grid.element.children).toHaveLength(2);
    });
    wrapper.unmount();
  });

  it("alternates the section layout down the page", () => {
    const wrapper = mount(NeonPixelsPage);
    const columnsFor = (id: string) =>
      wrapper.get(`section#${id} .grid`).element.className;
    // Odd-indexed sections flip the visual to the left; a broken parity check
    // would still pass every other assertion, so pin the alternation here.
    expect(columnsFor("grimicorn")).toContain("0.72fr)_minmax(0,1fr)");
    expect(columnsFor("wanderist")).toContain("1fr)_minmax(0,0.72fr)");
    expect(columnsFor("basin")).toContain("0.72fr)_minmax(0,1fr)");
    expect(columnsFor("markpost")).toContain("1fr)_minmax(0,0.72fr)");
    wrapper.unmount();
  });

  it("links to every project's external site", () => {
    const wrapper = mount(NeonPixelsPage);
    const hrefs = wrapper
      .findAll("a[href]")
      .map((link) => link.attributes("href"));
    PROJECT_URLS.forEach((url) => {
      expect(hrefs).toContain(url);
    });
    wrapper.unmount();
  });

  it("opens external links safely and keeps in-page anchors internal", () => {
    const wrapper = mount(NeonPixelsPage);
    const allLinks = wrapper.findAll("a[href]");
    const externalLinks = allLinks.filter((link) =>
      isExternalHref(link.attributes("href") ?? ""),
    );
    const internalLinks = allLinks.filter(
      (link) => !isExternalHref(link.attributes("href") ?? ""),
    );

    // One CTA plus one footer link per project.
    expect(externalLinks).toHaveLength(PROJECT_URLS.length * 2);
    expect(internalLinks.length).toBeGreaterThan(0);

    externalLinks.forEach((externalLink) => {
      expect(externalLink.attributes("target")).toBe("_blank");
      const relTokens = (externalLink.attributes("rel") ?? "").split(/\s+/);
      expect(relTokens).toContain("noopener");
      expect(relTokens).toContain("noreferrer");
    });

    internalLinks.forEach((internalLink) => {
      expect(internalLink.attributes("href")).toMatch(/^#/);
      expect(internalLink.attributes("target")).toBeUndefined();
    });
    wrapper.unmount();
  });

  it.each(INTERACTIVE_FOCUS_CLASSES)(
    "renders every .%s as a focusable anchor with an href",
    (className) => {
      const wrapper = mount(NeonPixelsPage);
      // Assert every control of this class is an anchor that keeps its href
      // (stays in tab order), not just that one exists — a refactor dropping
      // the href on some would then fail here instead of passing silently.
      const controls = wrapper.findAll(`a.${className}`);
      expect(controls.length).toBeGreaterThan(0);
      expect(wrapper.findAll(`a.${className}[href]`).length).toBe(
        controls.length,
      );
      wrapper.unmount();
    },
  );
});
