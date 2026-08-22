import { describe, it, expect } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { PROJECTS } from "@theme/data/projects";

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

// Tabbable-element selector, shared by the skip-link ordering check and the
// aria-hidden visual guard so the two can't drift on what counts as focusable.
// Excludes the not-tabbable cases: disabled controls and any negative tabindex.
const TABBABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, object, embed, audio[controls], video[controls], details > summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"])';

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

// Derive the section ids from the data so a project added later is covered by
// the id-driven assertions below (notably the aria-hidden guard) instead of
// slipping past a hardcoded list.
const PROJECT_SECTION_IDS = PROJECTS.map((project) => project.id);

// Resolve a section's outer layout grid. Uses an attribute selector (no CSS
// escaping needed for ids like "basin.fm" or a leading digit) and the child
// combinator so it can't accidentally match a nested visual whose own root
// carries a `grid` class (the markpost mockup does).
const gridFor = (wrapper: VueWrapper, id: string) =>
  wrapper.get(`section[id="${id}"] > .grid`);

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
    const tabbables = wrapper.findAll(TABBABLE_SELECTOR);
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
      expect(wrapper.find(`section[id="${id}"]`).exists()).toBe(true);
    });
    wrapper.unmount();
  });

  it("drives its id-based assertions from a non-empty project list", () => {
    // An emptied PROJECTS would make every id-driven forEach below pass
    // vacuously (zero iterations, zero assertions). Guard it once, centrally,
    // so the protection can't be deleted along with any single loop.
    expect(PROJECT_SECTION_IDS.length).toBeGreaterThan(0);
  });

  it("renders both a summary and a bespoke visual in every section", () => {
    const wrapper = mount(NeonPixelsPage);
    // A section with no matching #visual branch would leave the grid with only
    // the summary column; assert both columns are present so a project added
    // without a visual fails here instead of shipping a half-empty section.
    PROJECT_SECTION_IDS.forEach((id) => {
      const grid = gridFor(wrapper, id);
      expect(grid.element.children).toHaveLength(2);
    });
    wrapper.unmount();
  });

  it("hides each decorative project visual from assistive technology", () => {
    const wrapper = mount(NeonPixelsPage);
    // Each section grid holds a summary column and a bespoke visual column.
    // The visuals are fabricated product mockups (a terminal, a heatmap, a
    // feed, in/out panels) whose text is illustrative chrome, not information
    // the page commits to — so the visual container must carry aria-hidden
    // while the summary (the real prose and CTA) must not. The layout flips the
    // visual to the left on odd-indexed sections (NeonPixelsPage sets `reverse`
    // from `projectIndex % 2 === 1`), so index the columns off that parity
    // rather than guessing which column is which by content.
    PROJECTS.forEach((project, projectIndex) => {
      const columns = Array.from(gridFor(wrapper, project.id).element.children);
      expect(columns).toHaveLength(2);
      const visualIsFirst = projectIndex % 2 === 1;
      const [visualColumn, summaryColumn] = visualIsFirst
        ? columns
        : [columns[1], columns[0]];
      // Confirm the parity-derived split is right: the summary column is the one
      // holding this project's CTA link, so a layout regression fails loudly
      // here instead of silently mislabelling the columns.
      expect(
        summaryColumn.querySelector(`a[href="${project.url}"]`),
      ).not.toBeNull();
      expect(visualColumn.getAttribute("aria-hidden")).toBe("true");
      expect(summaryColumn.getAttribute("aria-hidden")).toBeNull();
      // aria-hidden on a container with a focusable descendant is itself an
      // ARIA violation (the control stays tabbable but has no accessible
      // name), so a future mockup must not introduce one — checked on the
      // column root and its descendants.
      expect(visualColumn.matches(TABBABLE_SELECTOR)).toBe(false);
      expect(visualColumn.querySelector(TABBABLE_SELECTOR)).toBeNull();
    });
    wrapper.unmount();
  });

  it("alternates the section layout down the page", () => {
    const wrapper = mount(NeonPixelsPage);
    const columnsFor = (id: string) => gridFor(wrapper, id).element.className;
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
