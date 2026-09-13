import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

// package.json pins vite/esbuild for vitepress via the `overrides.vitepress`
// block (see the comment above the `vite` key in .vitepress/config.ts). A
// major bump to vite or vitepress, landing on its own, previously skipped
// the "minor-and-patch" group and shipped as an unremarkable solo PR — easy
// to merge without noticing the override may need adjusting. dependabot.yml
// must always group these two together, including majors, ahead of the
// general minor-and-patch group.
//
// Anchored to this test file, not process.cwd(), so the reads still resolve
// if vitest is invoked from a subdirectory or given a custom root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEPENDABOT_CONFIG_PATH = path.join(REPO_ROOT, ".github/dependabot.yml");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const COUPLED_PACKAGES = ["vite", "vitepress"];

function readNpmUpdateEntry() {
  const raw = readFileSync(DEPENDABOT_CONFIG_PATH, "utf-8");
  const config = parse(raw);
  const npmEntry = config.updates.find(
    (update: { "package-ecosystem": string }) =>
      update["package-ecosystem"] === "npm",
  );

  if (!npmEntry) {
    throw new Error("No npm package-ecosystem entry found in dependabot.yml");
  }

  return npmEntry;
}

describe("dependabot.yml vite/vitepress grouping", () => {
  it("still documents the vitepress override pin this grouping exists for", () => {
    // If this ever fails, the overrides.vitepress coupling has been removed
    // from package.json and the vite-vitepress group below (and this whole
    // test file) should be reconsidered rather than left grouping bumps for
    // a pin that no longer exists.
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));

    expect(packageJson.overrides?.vitepress?.vite).toBeDefined();
    expect(packageJson.overrides?.vitepress?.esbuild).toBeDefined();
  });

  it("groups vite and vitepress together with no update-types filter", () => {
    const npmEntry = readNpmUpdateEntry();
    const coupledGroup = npmEntry.groups?.["vite-vitepress"];

    expect(coupledGroup).toBeDefined();
    expect(coupledGroup.patterns).toEqual(
      expect.arrayContaining(COUPLED_PACKAGES),
    );
    expect(coupledGroup.patterns).toHaveLength(COUPLED_PACKAGES.length);
    // Omitting `update-types` means the group matches every bump type,
    // including major — that's what closes the gap this test guards.
    expect(coupledGroup["update-types"]).toBeUndefined();
  });

  it("still groups every other package's minor and patch updates", () => {
    const npmEntry = readNpmUpdateEntry();
    const generalGroup = npmEntry.groups?.["minor-and-patch"];

    expect(generalGroup).toBeDefined();
    expect(generalGroup["update-types"]).toEqual(["minor", "patch"]);
  });

  it("lists the coupled group before minor-and-patch, since dependabot assigns a dependency to the first group it matches", () => {
    const npmEntry = readNpmUpdateEntry();
    const groupNames = Object.keys(npmEntry.groups ?? {});

    expect(groupNames).toContain("vite-vitepress");
    expect(groupNames).toContain("minor-and-patch");
    expect(groupNames.indexOf("vite-vitepress")).toBeLessThan(
      groupNames.indexOf("minor-and-patch"),
    );
  });

  it("is valid YAML with the expected top-level shape", () => {
    const raw = readFileSync(DEPENDABOT_CONFIG_PATH, "utf-8");
    const config = parse(raw);

    expect(config.version).toBe(2);
    expect(Array.isArray(config.updates)).toBe(true);
  });
});
