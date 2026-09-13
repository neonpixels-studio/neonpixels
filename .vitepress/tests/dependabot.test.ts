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

  if (!Array.isArray(config.updates)) {
    throw new Error("dependabot.yml has no top-level `updates` array");
  }

  const npmEntry = config.updates.find(
    (update: { "package-ecosystem": string }) =>
      update["package-ecosystem"] === "npm",
  );

  if (!npmEntry) {
    throw new Error("No npm package-ecosystem entry found in dependabot.yml");
  }

  return npmEntry;
}

function matchesEveryUpdateType(group: { "update-types"?: string[] }) {
  // The behavior under test is "majors are included", not "the key is
  // absent" — an explicit `update-types: [major, minor, patch]` is just as
  // valid as omitting the key entirely.
  return (
    group["update-types"] === undefined ||
    group["update-types"].includes("major")
  );
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
    // esbuild is deliberately absent from the group's `patterns`: it's only
    // ever nested under overrides.vitepress, never a direct dependency, so
    // Dependabot never opens a version PR for it on its own. If esbuild
    // ever becomes a direct devDependency, add it to COUPLED_PACKAGES and
    // to both groups in dependabot.yml.
    expect(packageJson.devDependencies?.esbuild).toBeUndefined();
  });

  it("groups vite and vitepress together for version updates, including majors", () => {
    const npmEntry = readNpmUpdateEntry();
    const coupledGroup = npmEntry.groups?.["vite-vitepress"];

    expect(coupledGroup).toBeDefined();
    expect(coupledGroup.patterns).toEqual(
      expect.arrayContaining(COUPLED_PACKAGES),
    );
    expect(coupledGroup.patterns).toHaveLength(COUPLED_PACKAGES.length);
    expect(matchesEveryUpdateType(coupledGroup)).toBe(true);
  });

  it("groups vite and vitepress together for security updates too", () => {
    // A group's patterns apply only to scheduled version updates unless
    // `applies-to: security-updates` is set. Without a matching security
    // group, a security-triggered vite/vitepress bump would still ship
    // solo, defeating the point of the grouping above.
    const npmEntry = readNpmUpdateEntry();
    const securityGroup = npmEntry.groups?.["vite-vitepress-security"];

    expect(securityGroup).toBeDefined();
    expect(securityGroup["applies-to"]).toBe("security-updates");
    expect(securityGroup.patterns).toEqual(
      expect.arrayContaining(COUPLED_PACKAGES),
    );
    expect(securityGroup.patterns).toHaveLength(COUPLED_PACKAGES.length);
  });

  it("still groups every other package's minor and patch version updates", () => {
    const npmEntry = readNpmUpdateEntry();
    const generalGroup = npmEntry.groups?.["minor-and-patch"];

    expect(generalGroup).toBeDefined();
    expect(generalGroup["update-types"]).toEqual(["minor", "patch"]);
  });

  it("lists the coupled group first, since dependabot assigns a dependency to the first group it matches", () => {
    const npmEntry = readNpmUpdateEntry();
    const groupNames = Object.keys(npmEntry.groups ?? {});

    expect(groupNames).toContain("vite-vitepress");
    expect(groupNames).toContain("minor-and-patch");
    // Asserted as an absolute position, not merely "before minor-and-patch":
    // any group inserted above vite-vitepress that also matches vite/vitepress
    // (e.g. a future catch-all) would silently steal the coupling otherwise.
    expect(groupNames[0]).toBe("vite-vitepress");
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
