import { describe, it, expect } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { PROJECTS, type Project } from "@theme/data/projects";
import { MAIN_CONTENT_ID } from "@theme/a11y";
import { TABBABLE_SELECTOR } from "../utils/tabbable";

// Interactive control classes the global :focus-visible ring lands on.
const INTERACTIVE_FOCUS_CLASSES = ["pill", "nav-link", "footer-link"];

// Matches any absolute URL (has a scheme) or a protocol-relative URL. In-page
// hash links (#top, #projects) are internal and must NOT open a new tab.
const EXTERNAL_HREF_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function isExternalHref(href: string) {
  return EXTERNAL_HREF_PATTERN.test(href);
}

// The one project visual that carries real information (trip-scale stats) and
// so is exposed to assistive tech as a labelled image instead of hidden. Every
// other visual stays decorative and aria-hidden.
const EXPOSED_VISUAL_PROJECT_ID = "wanderist";

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

// Resolve a section's outer layout grid. The child combinator is load-bearing:
// a plain descendant `.grid` would also match a nested visual whose own root
// carries a `grid` class (the markpost mockup does). The attribute selector
// needs no CSS escaping, so it stays correct whatever an id turns out to be.
const gridFor = (wrapper: VueWrapper, id: string) =>
  wrapper.get(`section[id="${id}"] > .grid`);

// A section's grid holds exactly two columns: the summary (the one carrying
// this project's CTA link) and the bespoke visual (the other one). Derive both
// here so the assistive-technology tests don't each re-derive the pair, and so
// the 2-column shape and the summary's presence are asserted in one place — a
// missing CTA or a third column fails loudly here rather than silently
// mis-identifying the visual downstream.
function columnsFor(wrapper: VueWrapper, project: Project) {
  const columns = Array.from(gridFor(wrapper, project.id).element.children);
  expect(columns).toHaveLength(2);
  const summaryColumn = columns.find((column) =>
    column.querySelector(`a[href="${project.url}"]`),
  );
  expect(summaryColumn).toBeDefined();
  const visualColumn = columns.find((column) => column !== summaryColumn);
  return { summaryColumn, visualColumn };
}

describe("NeonPixelsPage", () => {
  it("renders correctly", () => {
    const wrapper = mount(NeonPixelsPage);
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("exposes a single main landmark the skip link can target", () => {
    const wrapper = mount(NeonPixelsPage);
    // Exactly one primary landmark: assistive tech should find a single <main>,
    // not zero (no bypass target) or several (ambiguous). The skip link itself
    // now lives in AppLayout (shared with the 404 view); it's covered there.
    const landmarks = wrapper.findAll("main");
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0].attributes("id")).toBe(MAIN_CONTENT_ID);
    // Without tabindex="-1" the skip link can't move focus into <main> on
    // browsers that don't honor fragment-nav focus (Safari), so the bypass is
    // cosmetic. Pin the attribute here.
    expect(landmarks[0].attributes("tabindex")).toBe("-1");
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
      // Exactly one — a duplicated id in the data would leave a second section
      // untested here (and break the matching hero pill anchor) if we only
      // checked existence.
      expect(wrapper.findAll(`section[id="${id}"]`)).toHaveLength(1);
    });
    wrapper.unmount();
  });

  it("keeps the derived id list in lockstep with the expected project set", () => {
    // An emptied PROJECTS would make every id-driven forEach below pass
    // vacuously (zero iterations, zero assertions). Pinning the count against
    // the hand-written PROJECT_URLS list — the file's other source of truth for
    // "these are the projects" — guards that centrally and also fails loudly if
    // the two lists drift, instead of surfacing as an off-by-two elsewhere.
    expect(PROJECT_SECTION_IDS).toHaveLength(PROJECT_URLS.length);
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

  it("applies the correct assistive-technology treatment to each project visual", () => {
    const wrapper = mount(NeonPixelsPage);
    // Each section grid holds a summary column and a bespoke visual column.
    // Most visuals are fabricated product mockups (a terminal, a feed, in/out
    // panels) whose text is illustrative chrome, not information the page
    // commits to — so those containers must carry aria-hidden while the summary
    // (the real prose and CTA) must not. The wanderist visual is the sole
    // exception: its trip-scale figures are real content, so it's exposed as a
    // labelled image (asserted in its own test) rather than hidden.
    PROJECTS.forEach((project) => {
      const { summaryColumn, visualColumn } = columnsFor(wrapper, project);
      expect(summaryColumn?.getAttribute("aria-hidden")).toBeNull();
      // Every decorative visual is aria-hidden; the exposed wanderist one must
      // NOT be (it's a labelled image instead) — pinning both cases here means
      // re-hiding wanderist fails this test as well as its dedicated one.
      const expectedAriaHidden =
        project.id === EXPOSED_VISUAL_PROJECT_ID ? null : "true";
      expect(visualColumn?.getAttribute("aria-hidden")).toBe(
        expectedAriaHidden,
      );
      // aria-hidden (or the exposed role="img") on a container with a focusable
      // descendant is itself an ARIA violation (the control stays tabbable but
      // has no accessible name), so a future mockup must not introduce one —
      // checked on the column root and its descendants. This also keeps the
      // summary-detection above honest: it relies on the visuals carrying no
      // anchors.
      expect(visualColumn?.matches(TABBABLE_SELECTOR)).toBe(false);
      expect(visualColumn?.querySelector(TABBABLE_SELECTOR)).toBeNull();
    });
    wrapper.unmount();
  });

  it("exposes the wanderist trip stats to assistive technology as a labelled image", () => {
    const wrapper = mount(NeonPixelsPage);
    const wanderist = PROJECTS.find(
      (project) => project.id === EXPOSED_VISUAL_PROJECT_ID,
    );
    expect(wanderist).toBeDefined();
    const { visualColumn } = columnsFor(wrapper, wanderist!);
    expect(visualColumn).toBeDefined();
    // Real content, so it must be reachable — a summarizing role="img" label,
    // not aria-hidden, or screen-reader users lose the stats entirely.
    expect(visualColumn?.getAttribute("aria-hidden")).toBeNull();
    expect(visualColumn?.getAttribute("role")).toBe("img");
    const label = visualColumn?.getAttribute("aria-label") ?? "";
    expect(label).toContain("47 of 50 US states");
    expect(label).toContain("60,000+ miles");
    expect(label).toContain("3 countries");
    // The label must not drift from the visible mockup, so assert every figure
    // it announces also renders on screen (the drift that produced 26 vs 47).
    const visualText = visualColumn?.textContent ?? "";
    expect(visualText).toContain("47 / 50 states");
    expect(visualText).toContain("60k+ miles");
    expect(visualText).toContain("3 countries");
    // Pin the complete set of numbers in the two stat rows (caption + footer)
    // in order — "47 / 50", then "60k+ miles", "47 states", "3 countries" — so
    // re-hardcoding any figure (like the old contradictory 26) fails here.
    // Scoped to the .text-wanderist-label rows so unrelated future digits (a
    // year, a badge) don't misreport as an accessibility regression.
    const statRowText = Array.from(
      visualColumn?.querySelectorAll(".text-wanderist-label") ?? [],
    )
      .map((row) => row.textContent)
      .join(" ");
    expect(statRowText.match(/\d[\d,]*/g)).toEqual([
      "47",
      "50",
      "60",
      "47",
      "3",
    ]);
    wrapper.unmount();
  });

  it("alternates the section layout down the page", () => {
    const wrapper = mount(NeonPixelsPage);
    const gridClassFor = (id: string) => gridFor(wrapper, id).element.className;
    // Odd-indexed sections flip the visual to the left; a broken parity check
    // would still pass every other assertion, so pin the alternation here — the
    // single owner of the visual/summary ordering rule. Driven off the data so
    // a project added later is covered, not just the original four.
    PROJECTS.forEach((project, projectIndex) => {
      const expected =
        projectIndex % 2 === 1
          ? "1fr)_minmax(0,0.72fr)"
          : "0.72fr)_minmax(0,1fr)";
      expect(gridClassFor(project.id)).toContain(expected);
    });
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
