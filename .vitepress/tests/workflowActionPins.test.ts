import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOWS_DIR = resolve(process.cwd(), ".github/workflows");
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const PINNED_REFERENCE = /@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s+#\s*v\d+(\.\d+)*\S*\s*$/;

// Local actions (./) are exempt; they are versioned with the repo itself.
function isExempt(reference: string) {
  return reference.startsWith("./");
}

function collectUses() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      readFileSync(resolve(WORKFLOWS_DIR, file), "utf8")
        .split("\n")
        .map((line, index) => ({
          file,
          line: index + 1,
          match: USES_LINE.exec(line),
        }))
        .filter((entry) => entry.match !== null)
        .map((entry) => ({
          where: `${entry.file}:${entry.line}`,
          reference: entry.match![1],
          trailing: entry.match![2],
        })),
    );
}

const USES = collectUses().filter((entry) => !isExempt(entry.reference));

describe("workflow action pinning", () => {
  it("finds at least one external action reference", () => {
    expect(USES.length).toBeGreaterThan(0);
  });

  it("pins every action to a full 40-char commit SHA", () => {
    const unpinned = USES.filter(
      (entry) => !PINNED_REFERENCE.test(entry.reference),
    );
    expect(
      unpinned.map((entry) => `${entry.where} ${entry.reference}`),
    ).toEqual([]);
  });

  it("annotates every pin with a trailing version comment", () => {
    const missing = USES.filter(
      (entry) => !VERSION_COMMENT.test(entry.trailing),
    );
    expect(missing.map((entry) => `${entry.where} ${entry.reference}`)).toEqual(
      [],
    );
  });
});
