import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findIncompatibleConsumers,
  readOverriddenPackageNames,
  runOverrideCompatibilityCli,
  type Lockfile,
} from "../../security/checkOverrideCompatibility";

// Mirrors the real shape: minimatch 10 declares brace-expansion ^5 (fine),
// the root installs brace-expansion 5.x via the override.
function lockfileWithConsumer(consumerRange: string): Lockfile {
  return {
    packages: {
      "": { dependencies: {} },
      "node_modules/brace-expansion": { version: "5.0.12" },
      "node_modules/minimatch": {
        version: "10.2.6",
        dependencies: { "brace-expansion": "^5.0.8" },
      },
      "node_modules/legacy-glob": {
        version: "1.0.0",
        dependencies: { "brace-expansion": consumerRange },
      },
    },
  };
}

describe("readOverriddenPackageNames", () => {
  it("returns only top-level string overrides, skipping nested scopes", () => {
    expect(
      readOverriddenPackageNames({
        vitepress: { vite: "^6.4.3" },
        "brace-expansion": "^5.0.12",
      }),
    ).toEqual(["brace-expansion"]);
  });

  it("returns nothing when there are no overrides", () => {
    expect(readOverriddenPackageNames(undefined)).toEqual([]);
  });
});

describe("findIncompatibleConsumers", () => {
  it("passes when every declared range accepts the installed version", () => {
    expect(
      findIncompatibleConsumers(lockfileWithConsumer("^5.0.0"), [
        "brace-expansion",
      ]),
    ).toEqual([]);
  });

  it("flags a consumer whose declared range excludes the overridden major", () => {
    expect(
      findIncompatibleConsumers(lockfileWithConsumer("^1.1.7"), [
        "brace-expansion",
      ]),
    ).toEqual([
      {
        overriddenPackage: "brace-expansion",
        consumerPath: "node_modules/legacy-glob",
        declaredRange: "^1.1.7",
        installedVersion: "5.0.12",
      },
    ]);
  });

  it("flags optionalDependencies as well as dependencies", () => {
    const lockfile = lockfileWithConsumer("^5.0.0");
    lockfile.packages!["node_modules/legacy-glob"] = {
      version: "1.0.0",
      optionalDependencies: { "brace-expansion": "^2.0.1" },
    };
    expect(
      findIncompatibleConsumers(lockfile, ["brace-expansion"]),
    ).toHaveLength(1);
  });

  it("checks against the nearest installed copy, not an unrelated one", () => {
    const lockfile: Lockfile = {
      packages: {
        "node_modules/brace-expansion": { version: "5.0.12" },
        "node_modules/old/node_modules/brace-expansion": { version: "1.1.11" },
        "node_modules/old": {
          version: "1.0.0",
          dependencies: { "brace-expansion": "^1.1.7" },
        },
      },
    };
    expect(findIncompatibleConsumers(lockfile, ["brace-expansion"])).toEqual(
      [],
    );
  });

  it("walks up to an ancestor's node_modules to resolve a nested consumer", () => {
    const lockfile: Lockfile = {
      packages: {
        "node_modules/brace-expansion": { version: "5.0.12" },
        "node_modules/parent/node_modules/brace-expansion": {
          version: "1.1.11",
        },
        "node_modules/parent/node_modules/child": {
          version: "1.0.0",
          dependencies: { "brace-expansion": "^5.0.0" },
        },
        "node_modules/parent": { version: "1.0.0" },
      },
    };
    expect(findIncompatibleConsumers(lockfile, ["brace-expansion"])).toEqual([
      expect.objectContaining({
        consumerPath: "node_modules/parent/node_modules/child",
        installedVersion: "1.1.11",
      }),
    ]);
  });

  it("is generic over every overridden package", () => {
    const lockfile: Lockfile = {
      packages: {
        "node_modules/other": { version: "3.0.0" },
        "node_modules/consumer": {
          version: "1.0.0",
          dependencies: { other: "^2.0.0" },
        },
      },
    };
    expect(findIncompatibleConsumers(lockfile, ["other"])).toHaveLength(1);
  });

  it("skips ranges that are not semver ranges instead of flagging them", () => {
    expect(
      findIncompatibleConsumers(
        lockfileWithConsumer("github:someone/brace-expansion#main"),
        ["brace-expansion"],
      ),
    ).toEqual([]);
  });

  it("ignores consumers when the overridden package is not installed", () => {
    expect(
      findIncompatibleConsumers({ packages: {} }, ["brace-expansion"]),
    ).toEqual([]);
  });
});

describe("runOverrideCompatibilityCli", () => {
  let workDir = "";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "override-compat-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeProject(consumerRange: string) {
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({ overrides: { "brace-expansion": "^5.0.12" } }),
    );
    writeFileSync(
      join(workDir, "package-lock.json"),
      JSON.stringify(lockfileWithConsumer(consumerRange)),
    );
  }

  it("exits 0 when the override is compatible with every consumer", () => {
    writeProject("^5.0.0");
    expect(runOverrideCompatibilityCli(workDir)).toBe(0);
  });

  it("exits 1 and names the offending consumer when one is incompatible", () => {
    writeProject("^2.0.1");
    expect(runOverrideCompatibilityCli(workDir)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "node_modules/legacy-glob declares brace-expansion@^2.0.1",
      ),
    );
  });
});

describe("the real project", () => {
  it("has no consumer forced onto an incompatible override today", () => {
    expect(runOverrideCompatibilityCli(process.cwd())).toBe(0);
  });
});
