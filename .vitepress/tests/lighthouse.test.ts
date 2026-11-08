import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const LIGHTHOUSE_CONFIG_FILE = ".lighthouserc.json";
const LIGHTHOUSE_ORIGIN = "http://localhost";
const HOME_PATH = "/";
const HOME_PAGE_SOURCE = "index.md";
const HTML_EXTENSION = ".html";
const NON_PAGE_MARKDOWN = new Set(["README.md"]);
// Netlify treats a redirect rule with no status as a 301.
const NETLIFY_DEFAULT_REDIRECT_STATUS = 301;
const REDIRECT_STATUS_FLOOR = 300;
const REDIRECT_STATUS_CEILING = 400;
const EXPECTED_MIN_SCORES: Record<string, number> = {
  "categories:performance": 0.85,
  "categories:accessibility": 0.85,
  "categories:best-practices": 0.95,
  "categories:seo": 0.85,
};
// Script-only or test-only dirs config.ts does not import into the build.
const NON_BUILD_VITEPRESS_DIRS = new Set([
  "tests",
  "perf",
  "links",
  "health",
  "security",
]);

const lighthouseConfig = JSON.parse(
  readFileSync(resolve(ROOT, LIGHTHOUSE_CONFIG_FILE), "utf8"),
);
const workflow = readFileSync(
  resolve(ROOT, ".github/workflows/ci.yml"),
  "utf8",
);
const netlifyToml = readFileSync(resolve(ROOT, "netlify.toml"), "utf8");
const siteConfig = readFileSync(resolve(ROOT, ".vitepress/config.ts"), "utf8");

function stripHtmlExtension(pathname: string) {
  if (!pathname.endsWith(HTML_EXTENSION)) {
    return pathname;
  }
  return pathname.slice(0, -HTML_EXTENSION.length);
}

function auditedPaths(): string[] {
  return lighthouseConfig.ci.collect.url.map(
    (url: string) => new URL(url).pathname,
  );
}

// The site builds with cleanUrls off, so /privacy.html is the file in dist.
function sourceFileForPath(pathname: string) {
  if (pathname === HOME_PATH) {
    return HOME_PAGE_SOURCE;
  }
  return `${stripHtmlExtension(pathname).slice(1)}.md`;
}

function publicPageSources() {
  return readdirSync(ROOT).filter(
    (file) =>
      file.endsWith(".md") &&
      !file.startsWith("_") &&
      !NON_PAGE_MARKDOWN.has(file),
  );
}

type Redirect = { from: string; status: number };

function parseRedirects(): Redirect[] {
  return netlifyToml
    .split("[[redirects]]")
    .slice(1)
    .map((block) => ({
      from: /^\s*from\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "",
      status: Number(
        /^\s*status\s*=\s*(\d+)/m.exec(block)?.[1] ??
          NETLIFY_DEFAULT_REDIRECT_STATUS,
      ),
    }));
}

function frontendFilterEntries() {
  const filter = /frontend:\n((?:\s+- '.*'\n)+)/.exec(workflow)?.[1] ?? "";
  return [...filter.matchAll(/- '(.*)'/g)].map((match) => match[1]);
}

function filterCovers(entries: string[], file: string) {
  return entries.some(
    (entry) => entry === file || file.startsWith(entry.replace(/\*\*$/, "")),
  );
}

type JobResult = "success" | "failure" | "cancelled" | "skipped";
type LighthouseContext = {
  ci: JobResult;
  changes: JobResult;
  frontend?: string;
  cancelled?: boolean;
};

const STATUS_FUNCTION = /\b(success|failure|cancelled|always)\(\)/;

function lighthouseCondition() {
  const block =
    /^ {2}lighthouse:\n(?:(?: {4,}.*)?\n)*?^ {4}if: >-\n((?: {6}.*\n)+)/m;
  const expression = block.exec(workflow)?.[1];
  if (!expression) {
    throw new Error("lighthouse job needs a folded `if: >-` condition");
  }
  return expression
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\$\{\{|\}\}$/g, "");
}

// GitHub adds an implicit success() to an `if:` with no status function, which
// skips the job whenever any needed job did not succeed.
function implicitSuccessHolds(condition: string, context: LighthouseContext) {
  if (STATUS_FUNCTION.test(condition)) {
    return true;
  }
  return context.ci === "success" && context.changes === "success";
}

// Evaluates the job `if:` for a combination of upstream results. Only the
// small expression subset the condition uses is translated to JavaScript.
function lighthouseRuns(context: LighthouseContext) {
  const condition = lighthouseCondition();
  if (/\b(success|failure|always)\(\)/.test(condition)) {
    throw new Error("lighthouseRuns only models !cancelled(); extend it");
  }
  const script = condition
    .replace(/needs\.(\w+)\.result/g, "results.$1")
    .replace(/needs\.changes\.outputs\.frontend/g, "frontend")
    .replace(/!cancelled\(\)/g, "!cancelled");
  const evaluate = new Function(
    "results",
    "frontend",
    "cancelled",
    `return ${script};`,
  );
  const expressionHolds = evaluate(
    { ci: context.ci, changes: context.changes },
    context.frontend ?? "",
    context.cancelled ?? false,
  ) as boolean;
  return implicitSuccessHolds(condition, context) && expressionHolds;
}

describe("lighthouse URL list", () => {
  it("audits at least one page, all on the static server origin", () => {
    const urls: string[] = lighthouseConfig.ci.collect.url;
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).origin).toBe(LIGHTHOUSE_ORIGIN);
    }
  });

  it.each(auditedPaths())("%s maps to an existing page source", (pathname) => {
    expect(existsSync(resolve(ROOT, sourceFileForPath(pathname)))).toBe(true);
  });

  it("covers every public page in the repo", () => {
    const audited = auditedPaths().map(sourceFileForPath).sort();
    expect(audited).toEqual(publicPageSources().sort());
  });

  it.each(auditedPaths())("%s is not redirected away", (pathname) => {
    const aliases = [pathname, stripHtmlExtension(pathname)];
    const redirected = parseRedirects().filter(
      (redirect) =>
        aliases.includes(redirect.from) &&
        redirect.status >= REDIRECT_STATUS_FLOOR &&
        redirect.status < REDIRECT_STATUS_CEILING,
    );
    expect(redirected).toEqual([]);
  });

  it("audits the production static build, never a dev server", () => {
    expect(lighthouseConfig.ci.collect.staticDistDir).toBe(".vitepress/dist");
    expect(lighthouseConfig.ci.collect.startServerCommand).toBeUndefined();
  });
});

describe("lighthouse assertions", () => {
  const assertions: Record<string, [string, Record<string, unknown>]> =
    lighthouseConfig.ci.assert.assertions;

  it("asserts exactly the expected categories", () => {
    expect(Object.keys(assertions).sort()).toEqual(
      Object.keys(EXPECTED_MIN_SCORES).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_MIN_SCORES))(
    "%s is error-level at minScore %s on the median run",
    (category, minScore) => {
      const [level, options] = assertions[category];
      expect(level).toBe("error");
      expect(options).toEqual({ minScore, aggregationMethod: "median-run" });
    },
  );
});

describe("lighthouse change detection", () => {
  const entries = frontendFilterEntries();

  it("parses the frontend path filter", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(auditedPaths().map(sourceFileForPath))(
    "re-runs when audited page source %s changes",
    (source) => {
      expect(filterCovers(entries, source)).toBe(true);
    },
  );

  it("re-runs when the lighthouse config or workflow changes", () => {
    expect(filterCovers(entries, LIGHTHOUSE_CONFIG_FILE)).toBe(true);
    expect(filterCovers(entries, ".github/workflows/ci.yml")).toBe(true);
  });

  it("covers every .vitepress module config.ts imports into the build", () => {
    const imported = [
      ...siteConfig.matchAll(/from "\.\/([^/"]+)\/[^"]*"/g),
    ].map((match) => match[1]);
    expect(imported.length).toBeGreaterThan(0);
    for (const directory of new Set(imported)) {
      expect(filterCovers(entries, `.vitepress/${directory}/x.ts`)).toBe(true);
    }
  });

  it("does not watch script-only or test-only .vitepress dirs", () => {
    for (const directory of NON_BUILD_VITEPRESS_DIRS) {
      expect(filterCovers(entries, `.vitepress/${directory}/x.ts`)).toBe(false);
    }
  });
});

describe("lighthouse job wiring", () => {
  it("gates with a job-level if, never workflow-level paths", () => {
    const triggers = /^on:\n((?:[ \t].*\n|\n)+)/m.exec(workflow)?.[1] ?? "";
    expect(triggers).toContain("pull_request:");
    expect(triggers).not.toMatch(/^\s+paths(-ignore)?:/m);
  });

  it("names the job exactly lighthouse", () => {
    expect(workflow).toMatch(/^ {2}lighthouse:\s*$/m);
  });

  it("fails closed: runs the audit when the changes job did not succeed", () => {
    expect(lighthouseRuns({ ci: "success", changes: "failure" })).toBe(true);
    expect(lighthouseRuns({ ci: "success", changes: "cancelled" })).toBe(true);
  });

  it("runs only for relevant paths when changes succeeds", () => {
    expect(
      lighthouseRuns({ ci: "success", changes: "success", frontend: "true" }),
    ).toBe(true);
    expect(
      lighthouseRuns({ ci: "success", changes: "success", frontend: "false" }),
    ).toBe(false);
  });

  it("skips when changes succeeds but reports no frontend output", () => {
    expect(lighthouseRuns({ ci: "success", changes: "success" })).toBe(false);
  });

  it("skips on push runs where changes is skipped", () => {
    expect(lighthouseRuns({ ci: "success", changes: "skipped" })).toBe(false);
  });

  it("never runs when ci failed or the workflow was cancelled", () => {
    expect(lighthouseRuns({ ci: "failure", changes: "failure" })).toBe(false);
    expect(lighthouseRuns({ ci: "cancelled", changes: "failure" })).toBe(false);
    expect(lighthouseRuns({ ci: "skipped", changes: "failure" })).toBe(false);
    expect(
      lighthouseRuns({ ci: "failure", changes: "success", frontend: "true" }),
    ).toBe(false);
    expect(
      lighthouseRuns({ ci: "success", changes: "failure", cancelled: true }),
    ).toBe(false);
  });
});
