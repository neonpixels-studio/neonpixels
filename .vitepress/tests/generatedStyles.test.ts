import { describe, expect, it } from "vitest";

import { BRAND_ACCENTS, WORDMARK_GRADIENT } from "../theme/brand";
import { PROJECTS } from "../theme/data/projects";
import {
  basinDotClass,
  buildGeneratedCss,
  buildGeneratedRules,
  formatDeclarations,
  projectStyleClass,
  tripCellClass,
} from "../theme/generatedStyles";
import { hexToRgba } from "../theme/utils/color";

const css = buildGeneratedCss();
const rules = buildGeneratedRules();

function declarationsOf(className: string) {
  const declarations = rules[className];
  if (!declarations) {
    throw new Error(`no generated rule for .${className}`);
  }
  return formatDeclarations(declarations);
}

describe("buildGeneratedCss", () => {
  it("emits one single-line rule per class with no nesting", () => {
    for (const line of css.split("\n")) {
      expect(line).toMatch(/^\.[\w-]+\{[^{}]*\}$/);
    }
  });

  it("writes every rule it generates", () => {
    for (const className of Object.keys(rules)) {
      expect(css).toContain(`.${className}{${declarationsOf(className)}}`);
    }
  });

  it("generates the wordmark gradient from the brand constant", () => {
    expect(declarationsOf("wordmark-gradient")).toBe(
      `background-image:${WORDMARK_GRADIENT}`,
    );
  });

  it("derives the hero rule glow from the lime accent", () => {
    expect(declarationsOf("hero-rule-glow")).toBe(
      `box-shadow:0 0 6px ${BRAND_ACCENTS.lime}`,
    );
  });

  it.each(PROJECTS)("styles every part of the $id project", (project) => {
    expect(declarationsOf(projectStyleClass(project.id, "section"))).toBe(
      `background:${project.section.background}`,
    );
    expect(declarationsOf(projectStyleClass(project.id, "top-line"))).toBe(
      `background:${project.section.topLine}`,
    );
    expect(declarationsOf(projectStyleClass(project.id, "accent"))).toBe(
      `--accent:${project.color}`,
    );
    expect(declarationsOf(projectStyleClass(project.id, "pill"))).toContain(
      `border-color:${project.pillBorder}`,
    );
    expect(declarationsOf(projectStyleClass(project.id, "pill-dot"))).toContain(
      `box-shadow:0 0 7px ${project.color}`,
    );
  });

  it("derives each aurora from the project accent and its own duration", () => {
    const [project] = PROJECTS;
    const declarations = declarationsOf(
      projectStyleClass(project.id, "aurora"),
    );
    expect(declarations).toContain(
      `--np-aurora-dur:${project.section.aurora.duration}`,
    );
    expect(declarations).toContain(
      hexToRgba(project.color, project.section.aurora.alpha),
    );
  });

  it("gives the filled CTA its glow shadow and hover glow", () => {
    const [project] = PROJECTS;
    const declarations = declarationsOf(
      projectStyleClass(project.id, "cta-fill"),
    );
    expect(declarations).toContain(`--accent:${project.color}`);
    expect(declarations).toContain(
      `0 0 26px ${hexToRgba(project.color, 0.35)}`,
    );
    expect(declarations).toContain(
      `--accent-glow:${hexToRgba(project.color, 0.6)}`,
    );
  });

  it("glows the heading text in the project accent", () => {
    const [project] = PROJECTS;
    expect(declarationsOf(projectStyleClass(project.id, "heading-glow"))).toBe(
      `text-shadow:0 0 18px ${hexToRgba(project.color, 0.6)}`,
    );
  });

  it("lights only the brightest trip-log cell with a glow", () => {
    expect(declarationsOf(tripCellClass("on"))).toContain("box-shadow");
    for (const state of ["mid", "low", "off"] as const) {
      expect(declarationsOf(tripCellClass(state))).not.toContain("box-shadow");
    }
  });

  it("fades the Basin feed dots and glows only the freshest", () => {
    expect(declarationsOf(basinDotClass(0))).toContain("box-shadow");
    expect(declarationsOf(basinDotClass(1))).toBe(
      `background:${BRAND_ACCENTS.amber}88`,
    );
    expect(declarationsOf(basinDotClass(3))).not.toContain("box-shadow");
  });

  it("rejects a project id that cannot be a class name", () => {
    const [project] = PROJECTS;
    expect(() => buildGeneratedCss([{ ...project, id: "bad id{}" }])).toThrow(
      /cannot be used in a CSS class name/,
    );
  });
});
