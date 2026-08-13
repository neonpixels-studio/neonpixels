import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mount } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";

// The custom dark theme can't rely on the browser default focus ring being
// visible, so every interactive control must define an explicit focus-visible
// outline. happy-dom doesn't evaluate `:focus-visible` or compute scoped CSS,
// so the guarantee is asserted against the component's own <style> source.
const INTERACTIVE_FOCUS_CLASSES = ["pill", "nav-link", "footer-link"];

// path.resolve off the test file's own dir, not `new URL(relative, import.meta.url)`:
// Vite rewrites the latter into an asset URL (non-file scheme) that fileURLToPath
// then rejects, so the string-based resolve is what keeps this readable at runtime.
const NEON_PIXELS_PAGE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../theme/components/NeonPixelsPage.vue",
);

const NEON_PIXELS_PAGE_SOURCE = readFileSync(NEON_PIXELS_PAGE_PATH, "utf8");

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

  it("renders every interactive control that gets a focus-visible ring", () => {
    const wrapper = mount(NeonPixelsPage);
    // A renamed/removed class would leave its focus rule targeting nothing, so
    // pin that each focus-styled class is actually present in the markup.
    INTERACTIVE_FOCUS_CLASSES.forEach((className) => {
      expect(wrapper.find(`.${className}`).exists()).toBe(true);
    });
    wrapper.unmount();
  });

  it.each(INTERACTIVE_FOCUS_CLASSES)(
    "defines a focus-visible outline for .%s",
    (className) => {
      const focusRulePattern = new RegExp(
        `\\.${className}:focus-visible[^{]*\\{[^}]*outline:`,
      );
      expect(NEON_PIXELS_PAGE_SOURCE).toMatch(focusRulePattern);
    },
  );
});
