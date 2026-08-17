import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SUPPRESSED_OUTLINE_PATTERN,
  OUTLINE_UTILITY_PATTERN,
  stripComments,
} from "./utils/outlineGuard";

// style.test.ts guards only the global stylesheet. A component <style> block
// setting `outline: none` — or a focus:outline-none / outline-hidden utility in
// markup — would silently defeat the global :focus-visible ring, so scan every
// component file for both forms. Anchored to this test file (not process.cwd())
// so the scan resolves regardless of how vitest is invoked. Scans the whole
// `.vitepress/` tree, not just theme/, so a Vue component added anywhere under
// it (not only in theme/components) is covered.
const SCAN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXCLUDED_DIR_PATTERN = /(^|\/)(node_modules|dist|cache)(\/|$)/;

// Normalize to forward slashes first so EXCLUDED_DIR_PATTERN and the `.vue`
// check behave identically on Windows, where recursive readdir uses `\`.
function componentFiles() {
  return readdirSync(SCAN_DIR, { recursive: true })
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter(
      (entry) => entry.endsWith(".vue") && !EXCLUDED_DIR_PATTERN.test(entry),
    )
    .map((entry) => path.join(SCAN_DIR, entry));
}

// Returns "path (matched text)" for every hit across the given files (default:
// all component files), so a failure names each file and the exact offending
// snippet. `files` is injectable so the reporting path can be tested positively.
// The shared patterns are non-global (they carry no lastIndex, keeping the
// `.test()` fixtures deterministic); matchAll needs a global copy to list every
// occurrence rather than just the first.
function offenders(pattern: RegExp, files = componentFiles()) {
  const globalPattern = new RegExp(pattern, "g");
  const hits: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    const matches = [...source.matchAll(globalPattern)];
    if (!matches.length) {
      continue;
    }
    const relativePath = path.relative(SCAN_DIR, file);
    hits.push(
      ...matches.map((match) => `${relativePath} (${match[0].trim()})`),
    );
  }
  return hits;
}

describe("component focus-ring suppression guard", () => {
  it("finds component files to scan", () => {
    expect(componentFiles().length).toBeGreaterThan(0);
  });

  it("never suppresses an outline in a component's styles", () => {
    const found = offenders(SUPPRESSED_OUTLINE_PATTERN);
    expect(found, `outline suppression found: ${found.join(", ")}`).toEqual([]);
  });

  it("never uses an outline-hiding utility class in markup", () => {
    const found = offenders(OUTLINE_UTILITY_PATTERN);
    expect(found, `outline-hiding utility found: ${found.join(", ")}`).toEqual(
      [],
    );
  });

  // Proves the scanning path itself bites: the guards above read real files that
  // all pass, so without this the suite would stay green even if offenders() were
  // wired to always return []. Report both planted suppressions, not just one.
  it("reports every planted suppression in a scanned file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "outline-guard-"));
    const planted = path.join(directory, "Planted.vue");
    writeFileSync(planted, "<style>.a{outline:none}.b{outline:0}</style>");
    expect(offenders(SUPPRESSED_OUTLINE_PATTERN, [planted])).toHaveLength(2);
  });
});
