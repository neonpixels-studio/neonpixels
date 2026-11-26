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

const ASSIGNMENT_PATTERN =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;
const SURROUNDING_QUOTES_PATTERN = /^["']|["']$/g;
const GITIGNORE_PATH = resolve(process.cwd(), ".gitignore");
const ENV_KEYS_FILE = ".env.keys";

type Assignment = { name: string; value: string };

// Reads names and raw values only; nothing is decrypted.
function readAssignments(path: string): Assignment[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.match(ASSIGNMENT_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ name: match[1], value: match[2].trim() }));
}

function isEncrypted(assignment: Assignment) {
  const unquoted = assignment.value.replace(SURROUNDING_QUOTES_PATTERN, "");
  return unquoted.startsWith(ENCRYPTED_PREFIX);
}

const productionAssignments = readAssignments(ENV_PRODUCTION_PATH);
const exampleAssignments = readAssignments(ENV_EXAMPLE_PATH);

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
      .filter((assignment) => !isEncrypted(assignment))
      .map((assignment) => assignment.name);
    expect(plaintext).toEqual([]);
  });

  it("declares the dotenvx public key", () => {
    expect(
      productionAssignments.map((assignment) => assignment.name),
    ).toContain(PUBLIC_KEY_NAME);
  });
});

describe(".env.keys", () => {
  it("is git-ignored so the private key is never committed", () => {
    const ignored = readFileSync(GITIGNORE_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim());
    expect(ignored).toContain(ENV_KEYS_FILE);
  });
});

describe("build:production script", () => {
  it("runs the build strictly under dotenvx so a missing key fails the build", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    expect(manifest.scripts["build:production"]).toBe(BUILD_PRODUCTION_SCRIPT);
  });
});
