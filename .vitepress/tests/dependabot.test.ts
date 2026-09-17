import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

// package.json pins vite/esbuild for vitepress via the `overrides.vitepress`
// block (see the comment above the `vite` key in .vitepress/config.ts). A
// major bump to vite or vitepress, landing on its own, previously skipped
// the "minor-and-patch" group (majors don't match its update-types filter)
// and shipped as an unremarkable solo PR — easy to merge without noticing
// the override may need adjusting. dependabot.yml must always fall through
// to a coupled vite-vitepress group for majors, while minor/patch bumps to
// either package keep landing in the general minor-and-patch group exactly
// as before this change.
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
const ALL_UPDATE_TYPES = ["major", "minor", "patch"];

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
}

function readAllDirectDependencies() {
  const packageJson = readPackageJson();

  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  };
}

// Any direct dependency with a required (non-optional) peer dependency on
// vite needs to ride in the same Dependabot group as vite: a vite major that
// outgrows one of these ranges must land together with that package's
// compatible release rather than splitting across two PRs and installing a
// mismatched peer range, breaking `npm ci`. Derived from each package's
// installed manifest — rather than hand-maintained — so a newly added
// vite-peer package is caught automatically instead of silently missing
// from the group's patterns. Requires `npm ci` to have run first; throws
// rather than silently under-counting if a listed dependency isn't
// installed, since a missing package would otherwise read as "not a vite
// peer" and mask a real gap in the group.
function findVitePeerDependents() {
  const allDependencies = readAllDirectDependencies();

  return Object.keys(allDependencies).filter((packageName) => {
    const manifestPath = path.join(
      REPO_ROOT,
      "node_modules",
      packageName,
      "package.json",
    );

    if (!existsSync(manifestPath)) {
      throw new Error(
        `${packageName} is listed in package.json but not installed under node_modules/ — run npm ci before this suite.`,
      );
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const hasVitePeer = manifest.peerDependencies?.vite !== undefined;
    const vitePeerIsOptional =
      manifest.peerDependenciesMeta?.vite?.optional === true;

    return hasVitePeer && !vitePeerIsOptional;
  });
}

function readNpmUpdateEntry() {
  const raw = readFileSync(DEPENDABOT_CONFIG_PATH, "utf-8");
  const config = parse(raw);

  if (!Array.isArray(config.updates)) {
    throw new Error("dependabot.yml has no top-level `updates` array");
  }

  const npmEntries = config.updates.filter(
    (update: { "package-ecosystem": string; directory: string }) =>
      update["package-ecosystem"] === "npm" && update.directory === "/",
  );

  if (npmEntries.length !== 1) {
    throw new Error(
      `Expected exactly one npm package-ecosystem entry for directory "/" in dependabot.yml, found ${npmEntries.length}`,
    );
  }

  return npmEntries[0];
}

function matchesEveryUpdateType(group: { "update-types"?: string[] }) {
  // The behavior under test is "every bump type is included", not "the key
  // is absent" — an explicit `update-types: [major, minor, patch]` is just
  // as valid as omitting the key entirely, but `update-types: [major]`
  // alone is not.
  const updateTypes = group["update-types"];

  if (updateTypes === undefined) {
    return true;
  }

  return ALL_UPDATE_TYPES.every((updateType) =>
    updateTypes.includes(updateType),
  );
}

describe("dependabot.yml vite/vitepress grouping", () => {
  it("still documents the vitepress override pin this grouping exists for", () => {
    // If this ever fails, the overrides.vitepress coupling has been removed
    // from package.json and the vite-vitepress group below (and this whole
    // test file) should be reconsidered rather than left grouping bumps for
    // a pin that no longer exists.
    const packageJson = readPackageJson();

    expect(packageJson.overrides?.vitepress?.vite).toBeDefined();
    expect(packageJson.overrides?.vitepress?.esbuild).toBeDefined();
    // esbuild is deliberately absent from the group's `patterns`: it's only
    // ever nested under overrides.vitepress, never a direct dependency, so
    // Dependabot never opens a version PR for it on its own. If esbuild
    // ever becomes a direct dependency (of any kind), add it to
    // COUPLED_PACKAGES and to both groups in dependabot.yml.
    expect(
      packageJson.dependencies?.esbuild ??
        packageJson.devDependencies?.esbuild ??
        packageJson.optionalDependencies?.esbuild,
    ).toBeUndefined();
  });

  it("groups vite, vitepress, and vite's peer-dependent packages together for version updates, including majors", () => {
    const npmEntry = readNpmUpdateEntry();
    const coupledGroup = npmEntry.groups?.["vite-vitepress"];
    const groupedPackages = [
      ...new Set([...COUPLED_PACKAGES, ...findVitePeerDependents()]),
    ];

    expect(groupedPackages.length).toBeGreaterThan(COUPLED_PACKAGES.length);
    expect(coupledGroup).toBeDefined();
    expect(coupledGroup.patterns).toEqual(
      expect.arrayContaining(groupedPackages),
    );
    expect(coupledGroup.patterns).toHaveLength(groupedPackages.length);
    expect(matchesEveryUpdateType(coupledGroup)).toBe(true);
  });

  it("groups vite, vitepress, and vite's peer-dependent packages together for security updates too", () => {
    // A group's patterns apply only to scheduled version updates unless
    // `applies-to: security-updates` is set. Without a matching security
    // group, a security-triggered vite/vitepress bump would still ship
    // solo, defeating the point of the grouping above.
    const npmEntry = readNpmUpdateEntry();
    const securityGroup = npmEntry.groups?.["vite-vitepress-security"];
    const groupedPackages = [
      ...new Set([...COUPLED_PACKAGES, ...findVitePeerDependents()]),
    ];

    expect(groupedPackages.length).toBeGreaterThan(COUPLED_PACKAGES.length);
    expect(securityGroup).toBeDefined();
    expect(securityGroup["applies-to"]).toBe("security-updates");
    expect(securityGroup.patterns).toEqual(
      expect.arrayContaining(groupedPackages),
    );
    expect(securityGroup.patterns).toHaveLength(groupedPackages.length);
  });

  it("still groups every other package's minor and patch version updates", () => {
    const npmEntry = readNpmUpdateEntry();
    const generalGroup = npmEntry.groups?.["minor-and-patch"];

    expect(generalGroup).toBeDefined();
    expect(generalGroup["update-types"]).toEqual(["minor", "patch"]);
  });

  it("lists minor-and-patch before vite-vitepress, since dependabot assigns a dependency to the first group it matches", () => {
    // minor-and-patch goes first so vite/vitepress minor and patch bumps
    // keep landing in the general weekly PR, unchanged from before this
    // fix. Only majors — which minor-and-patch's update-types filter
    // excludes — fall through to vite-vitepress. Asserted as an absolute
    // position, not merely "before vite-vitepress": a future group inserted
    // above minor-and-patch that also matches vite/vitepress would silently
    // change this behavior otherwise.
    const npmEntry = readNpmUpdateEntry();
    const groupNames = Object.keys(npmEntry.groups ?? {});

    expect(groupNames).toContain("vite-vitepress");
    expect(groupNames).toContain("minor-and-patch");
    expect(groupNames[0]).toBe("minor-and-patch");
    expect(groupNames.indexOf("minor-and-patch")).toBeLessThan(
      groupNames.indexOf("vite-vitepress"),
    );
  });

  it("is valid YAML with the expected top-level shape", () => {
    const raw = readFileSync(DEPENDABOT_CONFIG_PATH, "utf-8");
    const config = parse(raw);

    expect(config.version).toBe(2);
    expect(Array.isArray(config.updates)).toBe(true);
  });
});
