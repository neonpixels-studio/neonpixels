import { describe, it, expect } from "vitest";
import { PROJECTS } from "@theme/data/projects";

// The whole page is generated from PROJECTS, so a missing field fails quietly
// as blank markup rather than an error. Assert every entry is well-formed.
describe("PROJECTS data", () => {
  it("gives every project the fields the page renders", () => {
    PROJECTS.forEach((project) => {
      expect(project.id, "id").toBeTruthy();
      expect(project.name, "name").toBeTruthy();
      expect(project.tld, "tld").toBeTruthy();
      expect(project.url, `${project.id} url`).toMatch(/^https:\/\//);
      expect(project.color, `${project.id} color`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(["fill", "outline"]).toContain(project.variant);

      const requiredCopy = [
        "status",
        "order",
        "category",
        "description",
      ] as const;
      requiredCopy.forEach((field) => {
        expect(project[field], `${project.id} ${field}`).toBeTruthy();
      });

      expect(project.accent.text, `${project.id} accent.text`).toMatch(
        /^text-/,
      );
      expect(project.accent.bg, `${project.id} accent.bg`).toMatch(/^bg-/);
      expect(project.accent.border, `${project.id} accent.border`).toMatch(
        /^border-/,
      );

      const { background, topLine, aurora } = project.section;
      expect(background, `${project.id} background`).toContain("gradient");
      expect(topLine, `${project.id} topLine`).toContain("gradient");
      expect(aurora.animation, `${project.id} aurora.animation`).toMatch(
        /^animate-aurora(-reverse)?$/,
      );
      expect(aurora.position, `${project.id} aurora.position`).toBeTruthy();
      expect(aurora.size, `${project.id} aurora.size`).toBeTruthy();
      expect(aurora.duration, `${project.id} aurora.duration`).toMatch(
        /^\d+s$/,
      );
      expect(aurora.alpha, `${project.id} aurora.alpha`).toBeGreaterThan(0);
      expect(aurora.alpha, `${project.id} aurora.alpha`).toBeLessThanOrEqual(1);
    });
  });

  it("validates the raw hex colors the hero pills render inline", () => {
    const pillFields = ["pillBg", "pillBgHover", "pillBorder"] as const;
    PROJECTS.forEach((project) => {
      pillFields.forEach((field) => {
        expect(project[field], `${project.id} ${field}`).toMatch(
          /^#[0-9a-f]{6}$/i,
        );
      });
    });
  });

  it("keeps position-derived fields in step with array order", () => {
    // reverse (in the page), the section counter, badge number, gradient angle
    // and aurora direction all alternate with index. Pin them to the array so a
    // reorder or insertion can't leave one pointing the old way.
    PROJECTS.forEach((project, index) => {
      const isEven = index % 2 === 0;
      expect(project.order, `${project.id} order`).toBe(
        String(index + 1).padStart(2, "0"),
      );
      expect(project.section.aurora.animation, `${project.id} animation`).toBe(
        isEven ? "animate-aurora" : "animate-aurora-reverse",
      );
      expect(project.section.background, `${project.id} background`).toContain(
        isEven ? "100deg" : "260deg",
      );
      expect(project.section.topLine, `${project.id} topLine`).toContain(
        isEven ? "90deg" : "270deg",
      );
    });
  });

  it("keeps project ids unique", () => {
    const ids = PROJECTS.map((project) => project.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
