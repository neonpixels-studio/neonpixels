import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { PROJECTS } from "@theme/data/projects";

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

// Derive the section ids from the data so a project added later is covered by
// every id-driven assertion below (notably the aria-hidden guard) instead of
// slipping past a hardcoded list.
const PROJECT_SECTION_IDS = PROJECTS.map((project) => project.id);

describe("NeonPixelsPage", () => {
  it("renders correctly", () => {
    const wrapper = mount(NeonPixelsPage);
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
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

  it("hides each decorative project visual from assistive technology", () => {
    const wrapper = mount(NeonPixelsPage);
    // Each section grid holds a summary column and a bespoke visual column.
    // The visuals are fabricated product mockups (a terminal, a heatmap, a
    // feed, in/out panels) whose text is illustrative chrome, not information
    // the page commits to — so the visual container must carry aria-hidden
    // while the summary (the real prose and CTA) must not. The summary is the
    // column carrying the external CTA link; identify it by content so this
    // survives the per-section layout flip without re-deriving the parity.
    PROJECT_SECTION_IDS.forEach((id) => {
      const grid = wrapper.get(`section#${id} > .grid`);
      const columns = Array.from(grid.element.children);
      expect(columns).toHaveLength(2);
      const summaryColumn = columns.find((column) =>
        column.querySelector("a[href]"),
      );
      const visualColumn = columns.find((column) => column !== summaryColumn);
      expect(visualColumn?.getAttribute("aria-hidden")).toBe("true");
      expect(summaryColumn?.getAttribute("aria-hidden")).toBeNull();
      // aria-hidden on a container with a focusable descendant is itself an
      // ARIA violation (the control stays tabbable but has no accessible
      // name), so a future mockup must not introduce one. This also keeps the
      // summary-detection heuristic above honest — it relies on the visuals
      // carrying no anchors.
      expect(
        visualColumn?.querySelector(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).toBeNull();
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
