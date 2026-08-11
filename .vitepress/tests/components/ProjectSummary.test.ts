import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import ProjectSummary from "@components/ProjectSummary.vue";
import { PROJECTS, type Project } from "@theme/data/projects";

// Build fixtures off a real project so the shape stays honest, but pin the
// variant/flicker flags here rather than mining PROJECTS by variant — that way
// these tests don't quietly break if every project ships as "fill" one day.
const baseProject: Project = { ...PROJECTS[0] };
const filledProject: Project = {
  ...baseProject,
  variant: "fill",
  flickerTld: true,
};
const outlineProject: Project = {
  ...baseProject,
  variant: "outline",
  flickerTld: false,
};

describe("ProjectSummary", () => {
  it("renders correctly", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("renders the project's status, order, category and copy", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    const text = wrapper.text();
    expect(text).toContain(outlineProject.status);
    expect(text).toContain(outlineProject.order);
    expect(text).toContain(outlineProject.category);
    expect(text).toContain(outlineProject.description);
    wrapper.unmount();
  });

  it("renders the name and tld with no gap so the wordmark reads as one", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    const heading = wrapper.find("h3").text();
    expect(heading).toBe(`${filledProject.name}${filledProject.tld}`);
    wrapper.unmount();
  });

  it("links the CTA to the external site and opens it safely", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    const cta = wrapper.find("a");
    expect(cta.attributes("href")).toBe(filledProject.url);
    expect(cta.attributes("target")).toBe("_blank");
    const relTokens = (cta.attributes("rel") ?? "").split(/\s+/);
    expect(relTokens).toContain("noopener");
    expect(relTokens).toContain("noreferrer");
    wrapper.unmount();
  });

  it("gives a fill variant a solid badge and CTA", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(wrapper.find("a").classes()).toContain("cta-fill");
    expect(wrapper.find("span").classes()).toContain(filledProject.accent.bg);
    wrapper.unmount();
  });

  it("gives an outline variant a bordered badge and CTA", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    const cta = wrapper.find("a");
    expect(cta.classes()).toContain("cta-outline");
    expect(cta.classes()).toContain(outlineProject.accent.border);
    wrapper.unmount();
  });

  it("exposes the project color to the outline hover via --accent", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    // --accent is the only thing driving .cta-outline:hover's background.
    const style = wrapper.find("a").attributes("style") ?? "";
    expect(style).toContain(`--accent: ${outlineProject.color}`);
    wrapper.unmount();
  });

  it("keeps the heading clamp and paragraph text-wrap in the rendered markup", async () => {
    // happy-dom's CSSOM drops clamp()/text-wrap, so the client snapshots can't
    // catch their removal. Server-render the raw markup, which preserves the
    // authored inline style verbatim, and assert on that instead.
    const html = await renderToString(
      createSSRApp({
        render: () => h(ProjectSummary, { project: filledProject }),
      }),
    );
    expect(html).toContain("font-size:clamp(38px, 5vw, 66px)");
    expect(html).toContain("text-wrap:pretty");
  });

  it("derives the fill hover glow from the project color, not a fixed lime", () => {
    const tealFill: Project = {
      ...baseProject,
      color: "#123456",
      variant: "fill",
    };
    const wrapper = mount(ProjectSummary, { props: { project: tealFill } });
    // --accent-glow feeds .cta-fill:hover; it must track the project color so a
    // non-lime fill project doesn't snap to lime on hover.
    const style = wrapper.find("a").attributes("style") ?? "";
    expect(style).toContain("--accent-glow: rgba(18, 52, 86, 0.6)");
    wrapper.unmount();
  });

  it("flickers the tld only when the project asks for it", () => {
    const flickerWrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(flickerWrapper.find("h3 span").classes()).toContain(
      "animate-flicker",
    );
    flickerWrapper.unmount();

    const steadyWrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    expect(steadyWrapper.find("h3 span").classes()).not.toContain(
      "animate-flicker",
    );
    steadyWrapper.unmount();
  });
});
