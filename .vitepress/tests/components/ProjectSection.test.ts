import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ProjectSection from "@components/ProjectSection.vue";
import { PROJECTS, type Project } from "@theme/data/projects";

const sampleProject = PROJECTS[0] as Project;

const VISUAL_MARKER = '<div class="visual-marker">visual</div>';

function mountSection(project: Project, reverse: boolean) {
  return mount(ProjectSection, {
    props: { project, reverse },
    slots: { visual: VISUAL_MARKER },
  });
}

describe("ProjectSection", () => {
  it("renders correctly", () => {
    const wrapper = mountSection(sampleProject, false);
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("renders a section anchored by the project id", () => {
    const wrapper = mountSection(sampleProject, false);
    expect(wrapper.find(`section#${sampleProject.id}`).exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the bespoke visual passed into the slot", () => {
    const wrapper = mountSection(sampleProject, false);
    expect(wrapper.find(".visual-marker").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the summary CTA linking to the project site", () => {
    const wrapper = mountSection(sampleProject, false);
    const hrefs = wrapper.findAll("a").map((link) => link.attributes("href"));
    expect(hrefs).toContain(sampleProject.url);
    wrapper.unmount();
  });

  it("places the summary before the visual by default", () => {
    const wrapper = mountSection(sampleProject, false);
    const grid = wrapper.get(".grid");
    const firstChild = grid.element.children[0] as HTMLElement;
    expect(firstChild.classList.contains("visual-marker")).toBe(false);
    expect(grid.element.className).toContain("0.72fr)_minmax(0,1fr)");
    wrapper.unmount();
  });

  it("places the visual before the summary when reversed", () => {
    const wrapper = mountSection(sampleProject, true);
    const grid = wrapper.get(".grid");
    const firstChild = grid.element.children[0] as HTMLElement;
    expect(firstChild.classList.contains("visual-marker")).toBe(true);
    expect(grid.element.className).toContain("1fr)_minmax(0,0.72fr)");
    wrapper.unmount();
  });
});
