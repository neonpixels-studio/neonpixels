import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PRODUCTION_PATH = resolve(process.cwd(), ".env.production");
const ENV_EXAMPLE_PATH = resolve(process.cwd(), ".env.example");
const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");
const PUBLIC_KEY_NAME = "DOTENV_PUBLIC_KEY_PRODUCTION";
const ENCRYPTED_PREFIX = "encrypted:";
const BUILD_PRODUCTION_SCRIPT =
  "dotenvx run --strict -f .env.production -- npm run build";

// Matches `NAME=value` lines, commented or not, so a documented-but-commented
// example variable still counts as declared.
const ASSIGNMENT_PATTERN = /^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/;

type Assignment = { name: string; value: string };

// Reads names and raw values only; nothing is decrypted.
function readAssignments(path: string, includeComments: boolean) {
  const assignments: Assignment[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const isComment = line.trimStart().startsWith("#");
    const match = line.match(ASSIGNMENT_PATTERN);
    if (match && (includeComments || !isComment)) {
      assignments.push({ name: match[1], value: match[2].trim() });
    }
  }
  return assignments;
}

const productionAssignments = readAssignments(ENV_PRODUCTION_PATH, false);
const exampleAssignments = readAssignments(ENV_EXAMPLE_PATH, false);

function dataNames(assignments: Assignment[]) {
  return assignments
    .map((assignment) => assignment.name)
    .filter((name) => name !== PUBLIC_KEY_NAME)
    .sort();
}

describe(".env.production and .env.example", () => {
  it("declare the same variable names (excluding the dotenvx public key)", () => {
    expect(dataNames(exampleAssignments)).toEqual(
      dataNames(productionAssignments),
    );
    expect(dataNames(productionAssignments).length).toBeGreaterThan(0);
  });

  it("keep .env.example free of values", () => {
    const withValues = exampleAssignments.filter(
      (assignment) => assignment.value !== "",
    );
    expect(withValues.map((assignment) => assignment.name)).toEqual([]);
  });

  it("encrypt every .env.production value except the dotenvx public key", () => {
    const plaintext = productionAssignments
      .filter((assignment) => assignment.name !== PUBLIC_KEY_NAME)
      .filter((assignment) => !assignment.value.includes(ENCRYPTED_PREFIX))
      .map((assignment) => assignment.name);
    expect(plaintext).toEqual([]);
  });

  it("declares the dotenvx public key", () => {
    expect(productionAssignments.map((entry) => entry.name)).toContain(
      PUBLIC_KEY_NAME,
    );
  });
});

describe("build:production script", () => {
  it("runs the build strictly under dotenvx so a missing key fails the build", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    expect(manifest.scripts["build:production"]).toBe(BUILD_PRODUCTION_SCRIPT);
  });
});
