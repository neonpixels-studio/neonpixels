import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECTS } from "@theme/data/projects";

// public/llms.txt hardcodes every project's link and blurb for AI discovery, but
// PROJECTS is the single source that drives the rendered page. Nothing links
// them, so adding, renaming or removing a project updates the page while llms.txt
// silently goes stale — the exact failure that matters for a studio pitching
// agent-driven development. This guard pins the ## Projects section to PROJECTS
// so a drift (missing, extra, reordered or mislabelled entry) fails, matching how
// the repo guards its other invariants (favicons resolve, og:image dims, CSP).
//
// The blurb text is a deliberate human paraphrase of project.description, so it
// is only checked for presence, not exact wording.

const LLMS_TXT_PATH = resolve(process.cwd(), "public/llms.txt");
const PROJECTS_HEADING = "Projects";
const SECTION_SPLIT = /^## /m;
const LIST_ITEM_PREFIX = "- ";
// The longest a blurb can be while still reading as a placeholder, not a real
// description. Entry blurbs must exceed this.
const MAX_PLACEHOLDER_BLURB_LENGTH = 20;

// Matches a Projects list line: "- [label](https://url): blurb".
const PROJECT_ENTRY = /^- \[([^\]]+)\]\((https:\/\/[^)]+)\): (.+)$/;

function readProjectsSections() {
  const llmsTxt = readFileSync(LLMS_TXT_PATH, "utf8");
  return llmsTxt
    .split(SECTION_SPLIT)
    .filter((block) => block.split("\n")[0].trim() === PROJECTS_HEADING);
}

function isListItem(line: string) {
  return line.startsWith(LIST_ITEM_PREFIX);
}

function parseLine(line: string) {
  const match = line.match(PROJECT_ENTRY);
  if (!match) {
    return { line, label: null, url: null, blurb: null };
  }
  return { line, label: match[1], url: match[2], blurb: match[3] };
}

// Parses totally (never throws) so a malformed line surfaces as a failed
// assertion naming the drift, not a file-level collection crash that skips every
// other check in this suite.
function parseProjects() {
  const sections = readProjectsSections();
  const lines = sections.flatMap((section) => section.split("\n"));
  const parsed = lines.filter(isListItem).map(parseLine);
  return {
    sectionCount: sections.length,
    entries: parsed.filter((item) => item.url !== null),
    malformed: parsed
      .filter((item) => item.url === null)
      .map((item) => item.line),
  };
}

const { sectionCount, entries: PROJECT_ENTRIES, malformed } = parseProjects();

describe("llms.txt stays in step with PROJECTS", () => {
  it("has exactly one ## Projects section", () => {
    expect(sectionCount).toBe(1);
  });

  it("has no malformed project entries", () => {
    expect(malformed).toEqual([]);
  });

  it("lists the project urls in PROJECTS order", () => {
    const listedUrls = PROJECT_ENTRIES.map((entry) => entry.url);
    const expectedUrls = PROJECTS.map((project) => project.url);
    expect(listedUrls).toEqual(expectedUrls);
  });

  it.each(PROJECTS)("labels $id with its name and tld", (project) => {
    const entry = PROJECT_ENTRIES.find(
      (candidate) => candidate.url === project.url,
    );
    expect(entry, `${project.id} missing from llms.txt`).toBeDefined();
    expect(entry?.label, `${project.id} label`).toBe(
      `${project.name}${project.tld}`,
    );
  });

  it.each(PROJECT_ENTRIES)("gives $label a sentence-length blurb", (entry) => {
    expect(
      entry.blurb?.trim().length ?? 0,
      `${entry.label} blurb`,
    ).toBeGreaterThan(MAX_PLACEHOLDER_BLURB_LENGTH);
  });
});
