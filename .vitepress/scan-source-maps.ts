import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Post-build gate for leftover source maps. Source maps are generated "hidden",
// uploaded to Sentry, then deleted via SOURCE_MAP_FILES_GLOB (see sentry-build.ts).
// If a Vite/VitePress output layout change stopped that glob matching, full maps
// would deploy publicly while every option-level unit test stayed green. This
// walks the built output and fails the build loud on any .map file or any
// sourceMappingURL comment. It runs on every build: without SENTRY_AUTH_TOKEN no
// maps are generated at all, so a clean local or CI build passes trivially.

const SOURCE_MAP_EXTENSION = ".map";
const SCANNED_EXTENSIONS = [".js", ".mjs", ".cjs", ".css", ".html"];
// A real reference is a comment (`//# ` or `/*# `). Deliberately not anchored to a
// line start, so minified same-line comments still fail the build (fail closed): a
// false positive is loud and fixable, a missed map ships publicly. A bare
// "sourceMappingURL=" string inside a bundled library is ignored.
const SOURCE_MAPPING_URL_COMMENT = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=/;

type SourceMapFinding = {
  file: string;
  reason: "map file" | "sourceMappingURL comment";
};

export function hasSourceMappingUrlComment(text: string) {
  return SOURCE_MAPPING_URL_COMMENT.test(text);
}

function listFiles(outDir: string) {
  return readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function isScannableFile(filePath: string) {
  return SCANNED_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function findingsForFile(filePath: string): SourceMapFinding[] {
  if (filePath.endsWith(SOURCE_MAP_EXTENSION)) {
    return [{ file: filePath, reason: "map file" }];
  }
  if (!isScannableFile(filePath)) {
    return [];
  }
  if (!hasSourceMappingUrlComment(readFileSync(filePath, "utf8"))) {
    return [];
  }
  return [{ file: filePath, reason: "sourceMappingURL comment" }];
}

export function scanBuildOutputForSourceMaps(outDir: string) {
  return listFiles(outDir).flatMap(findingsForFile);
}

function formatFindings(findings: SourceMapFinding[]) {
  return findings
    .map((finding) => `  ${finding.reason}: ${finding.file}`)
    .join("\n");
}

export function assertBuildOutputHasNoSourceMaps(outDir: string) {
  const findings = scanBuildOutputForSourceMaps(outDir);
  if (findings.length === 0) {
    return;
  }
  throw new Error(
    `Build output still contains source maps; they would deploy publicly (check SOURCE_MAP_FILES_GLOB in sentry-build.ts):\n${formatFindings(findings)}`,
  );
}
