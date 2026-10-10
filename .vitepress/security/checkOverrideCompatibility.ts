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
// Every string leaf is checked, however deeply it is nested: a parent-scoped
// entry such as `{ "minimatch": { "brace-expansion": "5" } }` is exactly what
// narrowing a blanket override produces, and a mismatch hidden there would be
// just as silent. The lockfile check is global per package name, which can
// only over-report for a scoped entry, never miss one. The deliberate range
// bumps in DELIBERATE_SCOPED_OVERRIDES are skipped.
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
  "peerDependencies",
] as const;

type DependencyMap = Record<string, string>;

export type LockfilePackage = {
  version?: string;
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
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

const DOT_OVERRIDE_KEY = ".";

// Keys may carry a version selector ("brace-expansion@^1", "@scope/pkg@^2");
// the lockfile is indexed by bare name. Start the search at index 1 so a
// scope's leading "@" isn't mistaken for the selector.
function packageNameFromOverrideKey(key: string) {
  const selectorStart = key.indexOf("@", 1);
  return selectorStart === -1 ? key : key.slice(0, selectorStart);
}

// Parent-scoped entries that deliberately move a build tool to a newer range
// for that parent only (see package.json). They are not mismatch masks, so
// they are exempt. Keep in sync with package.json when adding another.
const DELIBERATE_SCOPED_OVERRIDES: Record<string, readonly string[]> = {
  vitepress: ["vite", "esbuild"],
};

function isDeliberateScopedOverride(
  parentName: string | undefined,
  name: string,
) {
  if (
    parentName === undefined ||
    !Object.hasOwn(DELIBERATE_SCOPED_OVERRIDES, parentName)
  ) {
    return false;
  }
  return DELIBERATE_SCOPED_OVERRIDES[parentName].includes(name);
}

function isOverrideObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A string value forces the package for every consumer of its scope. An object
// value nests further overrides under that parent; its "." entry forces the
// parent itself like a string would. Non-string leaves are ignored.
function overriddenNamesForEntry(
  parentName: string | undefined,
  key: string,
  value: unknown,
): string[] {
  if (key === DOT_OVERRIDE_KEY) {
    return typeof value === "string" && parentName !== undefined
      ? [parentName]
      : [];
  }
  const name = packageNameFromOverrideKey(key);
  if (typeof value === "string") {
    return isDeliberateScopedOverride(parentName, name) ? [] : [name];
  }
  if (!isOverrideObject(value)) {
    return [];
  }
  return overriddenNamesIn(name, value);
}

function overriddenNamesIn(
  parentName: string | undefined,
  overrides: Record<string, unknown>,
): string[] {
  return Object.entries(overrides).flatMap(([key, value]) =>
    overriddenNamesForEntry(parentName, key, value),
  );
}

export function readOverriddenPackageNames(
  overrides: Record<string, unknown> | undefined,
) {
  return [...new Set(overriddenNamesIn(undefined, overrides ?? {}))];
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

// A lockfileVersion 1 file or a truncated one has no `packages` map; comparing
// against nothing would report PASS without checking anything.
function assertLockfileHasPackages(lockfile: Lockfile) {
  if (Object.keys(lockfile.packages ?? {}).length === 0) {
    throw new Error(
      `${LOCKFILE_NAME} has no "packages" map (lockfileVersion >= 2 required)`,
    );
  }
}

// Exported separately from main() so a test can assert on the exit code
// without spawning a `node` subprocess.
export function runOverrideCompatibilityCli(rootDir: string): number {
  const packageJson = readJson(resolve(rootDir, PACKAGE_JSON_NAME));
  const lockfile: Lockfile = readJson(resolve(rootDir, LOCKFILE_NAME));
  assertLockfileHasPackages(lockfile);
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
