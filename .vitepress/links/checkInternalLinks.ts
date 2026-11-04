import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

// Hand-maintained links (llms.txt, the /privacy and /dashboard redirects in
// netlify.toml, the manifest icons) can dangle without any test noticing.
// This walks the real build output and fails on any internal href/src,
// manifest icon src or llms.txt link that resolves to neither a file in
// dist nor a Netlify redirect/rewrite rule. Run after `npm run build` (see
// the link:check script and .github/workflows/ci.yml); the resolver logic is
// unit-tested against fixtures in ../tests/links.
//
// Resolution is deliberately strict: it does not assume Netlify's "Pretty
// URLs" setting, so `/privacy` only passes because netlify.toml rewrites it.

const DEFAULT_OUT_DIR = resolve(process.cwd(), ".vitepress/dist");
const DEFAULT_NETLIFY_TOML = resolve(process.cwd(), "netlify.toml");
const SITE_ORIGIN = "https://neonpixels.dev";
const PLACEHOLDER_ORIGIN = "http://placeholder.invalid";
const INDEX_HTML_FILE = "index.html";
const MANIFEST_FILE = "images/site.webmanifest";
const LLMS_FILE = "llms.txt";
const HTML_EXTENSION = ".html";
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

const URL_ATTRIBUTE_PATTERN = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MARKDOWN_LINK_PATTERN = /\]\(([^)\s]+)\)/g;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const REDIRECT_BLOCK_HEADER = "[[redirects]]";
const SECTION_HEADER_PATTERN = /^\s*\[/;
const TOML_STRING_FIELD_PATTERN = /^\s*(from|to)\s*=\s*"([^"]*)"/;
const TOML_STATUS_PATTERN = /^\s*status\s*=\s*(\d+)/;

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
}

export interface BrokenReference {
  source: string;
  reference: string;
  reason: string;
}

export interface LinkReference {
  source: string;
  url: string;
}

function emptyRule(): Partial<RedirectRule> {
  return {};
}

function isCompleteRule(rule: Partial<RedirectRule>): rule is RedirectRule {
  return Boolean(rule.from && rule.to && rule.status);
}

export function parseNetlifyRedirects(toml: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  let current: Partial<RedirectRule> | undefined;

  const flush = () => {
    if (current && isCompleteRule(current)) {
      rules.push(current);
    }
    current = undefined;
  };

  for (const line of toml.split("\n")) {
    if (line.trim() === REDIRECT_BLOCK_HEADER) {
      flush();
      current = emptyRule();
      continue;
    }
    if (SECTION_HEADER_PATTERN.test(line)) {
      flush();
      continue;
    }
    if (!current) {
      continue;
    }
    const field = TOML_STRING_FIELD_PATTERN.exec(line);
    if (field) {
      current[field[1] as "from" | "to"] = field[2];
    }
    const status = TOML_STATUS_PATTERN.exec(line);
    if (status) {
      current.status = Number(status[1]);
    }
  }
  flush();
  return rules;
}

export function extractHtmlUrls(html: string): string[] {
  return [...html.matchAll(URL_ATTRIBUTE_PATTERN)].map(
    (match) => match[1] ?? match[2],
  );
}

export function extractManifestIconUrls(manifestJson: string): string[] {
  const manifest = JSON.parse(manifestJson) as {
    icons?: { src?: string }[];
  };
  return (manifest.icons ?? [])
    .map((icon) => icon.src)
    .filter((src): src is string => Boolean(src));
}

export function extractLlmsUrls(llmsText: string): string[] {
  return [...llmsText.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => match[1]);
}

// Returns the site-absolute path ("/images/a.png") a reference points at, or
// undefined when it is external, a pure fragment, or a non-http scheme.
export function toInternalPath(
  url: string,
  sourcePath: string,
): string | undefined {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }
  const isSiteOrigin =
    trimmed === SITE_ORIGIN || trimmed.startsWith(`${SITE_ORIGIN}/`);
  if (
    !isSiteOrigin &&
    (SCHEME_PATTERN.test(trimmed) || trimmed.startsWith("//"))
  ) {
    return undefined;
  }
  const base = new URL(sourcePath, PLACEHOLDER_ORIGIN);
  const resolved = new URL(trimmed, base);
  if (!isSiteOrigin && resolved.origin !== PLACEHOLDER_ORIGIN) {
    return undefined;
  }
  return decodeURIComponent(resolved.pathname);
}

function ruleMatches(rule: RedirectRule, path: string): boolean {
  if (rule.from.startsWith("http")) {
    return false;
  }
  if (rule.from.endsWith("/*")) {
    const prefix = rule.from.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return rule.from === path;
}

export function findRedirect(
  path: string,
  rules: RedirectRule[],
): RedirectRule | undefined {
  return rules.find((rule) => ruleMatches(rule, path));
}

function candidateFiles(path: string): string[] {
  const relative = path.replace(/^\/+/, "");
  if (relative === "" || relative.endsWith("/")) {
    return [posix.join(relative, INDEX_HTML_FILE)];
  }
  return [relative];
}

function fileExistsInOutput(outDir: string, path: string): boolean {
  return candidateFiles(path).some((candidate) => {
    const absolute = join(outDir, candidate);
    return existsSync(absolute) && statSync(absolute).isFile();
  });
}

// Returns a failure reason, or undefined when the path is served.
export function checkPath(
  outDir: string,
  path: string,
  rules: RedirectRule[],
): string | undefined {
  if (fileExistsInOutput(outDir, path)) {
    return undefined;
  }
  const rule = findRedirect(path, rules);
  if (!rule) {
    return "no matching file or redirect in build output";
  }
  const target = toInternalPath(rule.to.replace(/:splat$/, ""), path);
  if (target === undefined) {
    return undefined;
  }
  if (fileExistsInOutput(outDir, target)) {
    return undefined;
  }
  return `redirect ${rule.from} -> ${rule.to} points at a missing file`;
}

export function findBrokenReferences(
  outDir: string,
  references: LinkReference[],
  rules: RedirectRule[],
): BrokenReference[] {
  const broken: BrokenReference[] = [];
  for (const { source, url } of references) {
    const sourcePath = source.startsWith("/") ? source : `/${source}`;
    const path = toInternalPath(url, sourcePath);
    const reason =
      path === undefined ? undefined : checkPath(outDir, path, rules);
    if (reason) {
      broken.push({ source, reference: url, reason });
    }
  }
  return broken;
}

function listHtmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listHtmlFiles(absolute);
    }
    return entry.name.endsWith(HTML_EXTENSION) ? [absolute] : [];
  });
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function collectReferences(outDir: string): LinkReference[] {
  const references: LinkReference[] = [];
  for (const file of listHtmlFiles(outDir)) {
    const source = file
      .slice(outDir.length + 1)
      .split("\\")
      .join("/");
    for (const url of extractHtmlUrls(readFileSync(file, "utf8"))) {
      references.push({ source, url });
    }
  }
  const manifest = readOptional(join(outDir, MANIFEST_FILE));
  for (const url of manifest ? extractManifestIconUrls(manifest) : []) {
    references.push({ source: MANIFEST_FILE, url });
  }
  const llms = readOptional(join(outDir, LLMS_FILE));
  for (const url of llms ? extractLlmsUrls(llms) : []) {
    references.push({ source: LLMS_FILE, url });
  }
  return references;
}

export function runInternalLinkCheckCli(
  outDir: string,
  netlifyTomlPath: string = DEFAULT_NETLIFY_TOML,
): number {
  if (!existsSync(join(outDir, INDEX_HTML_FILE))) {
    throw new Error(
      `No build output at ${outDir}; run \`npm run build\` first`,
    );
  }
  const rules = parseNetlifyRedirects(readOptional(netlifyTomlPath) ?? "");
  const references = collectReferences(outDir);
  const broken = findBrokenReferences(outDir, references, rules);
  if (broken.length === 0) {
    console.log(`[link-check] ${references.length} references resolve`);
    return EXIT_SUCCESS;
  }
  console.error(`[link-check] ${broken.length} broken reference(s):`);
  for (const { source, reference, reason } of broken) {
    console.error(`  ${source}: ${reference} (${reason})`);
  }
  return EXIT_FAILURE;
}

function main() {
  try {
    process.exitCode = runInternalLinkCheckCli(DEFAULT_OUT_DIR);
  } catch (error) {
    console.error(
      "[link-check]",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = EXIT_FAILURE;
  }
}

// Same entrypoint guard (and Node floor) as ../perf/checkPerformanceBudget.ts:
// fail loud where import.meta.main is unavailable rather than silently no-op.
if (import.meta.main === undefined) {
  throw new Error(
    "Link check: import.meta.main is unavailable on this Node version " +
      "(requires >=22.18 or >=24.2); the entrypoint guard cannot run",
  );
}
if (import.meta.main) {
  main();
}
