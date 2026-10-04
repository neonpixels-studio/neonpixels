import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import semver from "semver";

// package.json's top-level `overrides` force every consumer of a package onto
// one version, which is how brace-expansion is pinned to v5 for an advisory
// (see issue #159). The catch: npm applies the override silently, even when a
// consumer declares a range the forced version can never satisfy (e.g. a
// future minimatch 3 asking for brace-expansion ^1). Nothing fails at install
// time and `npm audit` stays green; the consumer just breaks at runtime.
//
// package-lock.json records each package's *declared* dependency ranges (not
// the override-rewritten ones), alongside the version actually installed. So
// the lockfile alone is enough to find those mismatches: no `npm ls` output
// parsing, no install required, deterministic for a given commit.
//
// Only top-level string overrides are checked. Nested objects (e.g. the
// `vitepress: { vite, esbuild }` entry) scope an override to one parent and
// are deliberate range bumps for that parent, not a blanket force.
//
// Executed with plain `node` against this .ts file directly (native type
// stripping), the same way ../perf/checkPerformanceBudget.ts is; see the note
// there about the Node floor.

const LOCKFILE_NAME = "package-lock.json";
const PACKAGE_JSON_NAME = "package.json";
const NODE_MODULES_SEGMENT = "node_modules/";
const DECLARED_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
] as const;

type DependencyMap = Record<string, string>;

export type LockfilePackage = {
  version?: string;
  link?: boolean;
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
};

export type Lockfile = {
  packages?: Record<string, LockfilePackage>;
};

export type Incompatibility = {
  overriddenPackage: string;
  consumerPath: string;
  declaredRange: string;
  installedVersion: string;
};

export function readOverriddenPackageNames(
  overrides: Record<string, unknown> | undefined,
) {
  return Object.entries(overrides ?? {})
    .filter(([, value]) => typeof value === "string")
    .map(([name]) => name);
}

function parentPath(packagePath: string) {
  const lastSegment = packagePath.lastIndexOf(NODE_MODULES_SEGMENT);
  return lastSegment <= 0 ? "" : packagePath.slice(0, lastSegment - 1);
}

function candidatePath(basePath: string, name: string) {
  const prefix = basePath === "" ? "" : `${basePath}/`;
  return `${prefix}${NODE_MODULES_SEGMENT}${name}`;
}

// Mirrors Node's resolution: the consumer's own nested node_modules first,
// then each ancestor's, ending at the root node_modules.
function resolveInstalledVersion(
  packages: Record<string, LockfilePackage>,
  consumerPath: string,
  name: string,
): string | undefined {
  const installed = packages[candidatePath(consumerPath, name)];
  if (installed?.version) {
    return installed.version;
  }
  if (consumerPath === "") {
    return undefined;
  }
  return resolveInstalledVersion(packages, parentPath(consumerPath), name);
}

function declaredRanges(entry: LockfilePackage, name: string) {
  return DECLARED_DEPENDENCY_FIELDS.map((field) => entry[field]?.[name]).filter(
    (range): range is string => typeof range === "string",
  );
}

// Ranges that aren't semver ranges (git URLs, `npm:` aliases, tags) can't be
// compared against a version, so they're skipped rather than flagged.
function isIncompatible(version: string, range: string) {
  if (semver.validRange(range) === null) {
    return false;
  }
  return !semver.satisfies(version, range, { includePrerelease: true });
}

function findIncompatibilitiesForConsumer(
  packages: Record<string, LockfilePackage>,
  consumerPath: string,
  overriddenPackage: string,
) {
  const installedVersion = resolveInstalledVersion(
    packages,
    consumerPath,
    overriddenPackage,
  );
  if (installedVersion === undefined) {
    return [];
  }
  return declaredRanges(packages[consumerPath], overriddenPackage)
    .filter((declaredRange) => isIncompatible(installedVersion, declaredRange))
    .map((declaredRange) => ({
      overriddenPackage,
      consumerPath: consumerPath === "" ? "<root>" : consumerPath,
      declaredRange,
      installedVersion,
    }));
}

function findIncompatibleConsumersOf(
  packages: Record<string, LockfilePackage>,
  overriddenPackage: string,
): Incompatibility[] {
  return Object.keys(packages).flatMap((consumerPath) =>
    findIncompatibilitiesForConsumer(packages, consumerPath, overriddenPackage),
  );
}

export function findIncompatibleConsumers(
  lockfile: Lockfile,
  overriddenPackages: string[],
) {
  const packages = lockfile.packages ?? {};
  return overriddenPackages.flatMap((name) =>
    findIncompatibleConsumersOf(packages, name),
  );
}

function formatIncompatibility(incompatibility: Incompatibility) {
  return (
    `  ${incompatibility.consumerPath} declares ` +
    `${incompatibility.overriddenPackage}@${incompatibility.declaredRange} ` +
    `but the override installs ${incompatibility.installedVersion}`
  );
}

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Exported separately from main() so a test can assert on the exit code
// without spawning a `node` subprocess.
export function runOverrideCompatibilityCli(rootDir: string): number {
  const packageJson = readJson(resolve(rootDir, PACKAGE_JSON_NAME));
  const lockfile: Lockfile = readJson(resolve(rootDir, LOCKFILE_NAME));
  const overriddenPackages = readOverriddenPackageNames(packageJson.overrides);
  const incompatibilities = findIncompatibleConsumers(
    lockfile,
    overriddenPackages,
  );
  if (incompatibilities.length === 0) {
    console.log(
      `[override-compat] ${overriddenPackages.length} override(s) checked - PASS`,
    );
    return EXIT_SUCCESS;
  }
  console.error(
    `[override-compat] ${incompatibilities.length} consumer(s) forced onto an incompatible version by package.json overrides:`,
  );
  for (const incompatibility of incompatibilities) {
    console.error(formatIncompatibility(incompatibility));
  }
  console.error(
    "[override-compat] narrow the override to the consumers that can take it, or drop it once the advisory is fixed upstream",
  );
  return EXIT_FAILURE;
}

function main() {
  try {
    process.exitCode = runOverrideCompatibilityCli(process.cwd());
  } catch (error) {
    console.error(
      "[override-compat]",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = EXIT_FAILURE;
  }
}

// `import.meta.main` needs Node >=22.18/24.2 and is `undefined` (not false)
// below that, which would make this guard silently skip main() and exit 0.
// Fail loud instead; .nvmrc pins 24.x today.
if (import.meta.main === undefined) {
  throw new Error(
    "Override compatibility check: import.meta.main is unavailable on this Node version (requires >=22.18 or >=24.2)",
  );
}
if (import.meta.main) {
  main();
}
