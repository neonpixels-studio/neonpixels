import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

// package.json pins vite/esbuild for vitepress via the `overrides.vitepress`
// block (see the comment above the `vite` key in .vitepress/config.ts). A
// major bump to any one of these three, landing on its own, can silently
// drift that pin — so dependabot.yml must always group them together,
// including majors, in front of the general minor-and-patch group.
const DEPENDABOT_CONFIG_PATH = resolve(process.cwd(), ".github/dependabot.yml");
const COUPLED_OVERRIDE_PACKAGES = ["vite", "vitepress", "esbuild"];

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
  it("groups vite, vitepress, and esbuild together with no update-types filter", () => {
    const npmEntry = readNpmUpdateEntry();
    const coupledGroup = npmEntry.groups?.["vite-vitepress"];

    expect(coupledGroup).toBeDefined();
    expect(coupledGroup.patterns).toEqual(
      expect.arrayContaining(COUPLED_OVERRIDE_PACKAGES),
    );
    expect(coupledGroup.patterns).toHaveLength(
      COUPLED_OVERRIDE_PACKAGES.length,
    );
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
