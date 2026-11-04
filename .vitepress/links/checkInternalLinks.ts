import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

// Hand-maintained links (llms.txt, the /privacy and /dashboard redirects in
// netlify.toml, the manifest icons) can dangle without any test noticing.
// This walks the real build output and fails on any internal href/src,
// srcset candidate, og:image/twitter:image meta URL, manifest icon src or
// llms.txt link that resolves to neither a file in dist nor a Netlify
// redirect/rewrite rule. Run after `npm run build` (see
// the link:check script and .github/workflows/ci.yml); the resolver logic is
// unit-tested against fixtures in ../tests/links.
//
// Resolution is deliberately strict: it does not assume Netlify's "Pretty
// URLs" setting, so `/privacy` only passes because netlify.toml rewrites it.

const DEFAULT_OUT_DIR = resolve(process.cwd(), ".vitepress/dist");
const DEFAULT_NETLIFY_TOML = resolve(process.cwd(), "netlify.toml");
const SITE_ORIGIN = "https://neonpixels.dev";
const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";
const INDEX_HTML_FILE = "index.html";
const MANIFEST_FILE = "images/site.webmanifest";
const LLMS_FILE = "llms.txt";
const HTML_EXTENSION = ".html";
const WILDCARD_SUFFIX = "/*";
const SPLAT_PLACEHOLDER = ":splat";
const ABSOLUTE_URL_PREFIX = "http";
const DEFAULT_REDIRECT_STATUS = 301;
const CLIENT_ERROR_STATUS_FLOOR = 400;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

const URL_ATTRIBUTE_PATTERN = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET_ATTRIBUTE_PATTERN = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const IMAGE_META_KEYS = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
]);
const DATA_URI_PREFIX = "data:";
const SRCSET_SEPARATOR_PATTERN = /[\s,]/;
const NON_WHITESPACE_PATTERN = /\S/;
const TRAILING_COMMAS_PATTERN = /,+$/;
const MARKDOWN_LINK_PATTERN = /\]\(([^)\s]+)\)/g;
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

function isCompleteRule(
  rule: Partial<RedirectRule>,
): rule is Partial<RedirectRule> & Pick<RedirectRule, "from" | "to"> {
  return Boolean(rule.from && rule.to);
}

export function parseNetlifyRedirects(toml: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  let current: Partial<RedirectRule> | undefined;

  const flush = () => {
    if (current && isCompleteRule(current)) {
      rules.push({
        ...current,
        status: current.status ?? DEFAULT_REDIRECT_STATUS,
      });
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

function skipWhile(text: string, position: number, pattern: RegExp): number {
  let cursor = position;
  while (cursor < text.length && pattern.test(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isDataUri(url: string): boolean {
  return url.toLowerCase().startsWith(DATA_URI_PREFIX);
}

// A URL with a trailing comma has no descriptors, so the next candidate
// starts right after it; otherwise descriptors run to the next comma.
function nextCandidateStart(
  srcset: string,
  position: number,
  endsWithComma: boolean,
): number {
  if (endsWithComma) {
    return position;
  }
  const nextComma = srcset.indexOf(",", position);
  return nextComma === -1 ? srcset.length : nextComma + 1;
}

// Follows the HTML srcset grammar: a candidate is a whitespace-free URL
// (which may itself contain commas, e.g. data: URIs) followed by optional
// descriptors up to the next comma. A trailing comma on the URL ends it.
export function parseSrcset(srcset: string): string[] {
  const urls: string[] = [];
  let position = 0;
  while (position < srcset.length) {
    const urlStart = skipWhile(srcset, position, SRCSET_SEPARATOR_PATTERN);
    position = skipWhile(srcset, urlStart, NON_WHITESPACE_PATTERN);
    const rawUrl = srcset.slice(urlStart, position);
    const url = rawUrl.replace(TRAILING_COMMAS_PATTERN, "");
    if (url && !isDataUri(url)) {
      urls.push(url);
    }
    position = nextCandidateStart(srcset, position, rawUrl !== url);
  }
  return urls;
}

export function extractSrcsetUrls(html: string): string[] {
  return [...html.matchAll(SRCSET_ATTRIBUTE_PATTERN)].flatMap((match) =>
    parseSrcset(match[1] ?? match[2]),
  );
}

function readAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3]);
  }
  return attributes;
}

export function extractImageMetaUrls(html: string): string[] {
  return [...html.matchAll(META_TAG_PATTERN)].flatMap((match) => {
    const attributes = readAttributes(match[0]);
    const key = (
      attributes.get("property") ??
      attributes.get("name") ??
      ""
    ).toLowerCase();
    const content = attributes.get("content");
    return IMAGE_META_KEYS.has(key) && content ? [content] : [];
  });
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
  const resolved = parseUrl(trimmed, new URL(sourcePath, PLACEHOLDER_ORIGIN));
  if (!resolved) {
    return trimmed;
  }
  const isInternal =
    resolved.hostname === new URL(PLACEHOLDER_ORIGIN).hostname ||
    resolved.hostname === new URL(SITE_ORIGIN).hostname;
  if (!isInternal) {
    return undefined;
  }
  return safeDecode(resolved.pathname);
}

function parseUrl(url: string, base: URL): URL | undefined {
  try {
    return new URL(url, base);
  } catch {
    return undefined;
  }
}

// A malformed escape is kept verbatim so it fails the file lookup with the
// offending reference attached, rather than crashing the whole run.
function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function splatFor(rule: RedirectRule, path: string): string {
  if (!rule.from.endsWith(WILDCARD_SUFFIX)) {
    return "";
  }
  return path
    .slice(rule.from.length - WILDCARD_SUFFIX.length)
    .replace(/^\//, "");
}

function ruleMatches(rule: RedirectRule, path: string): boolean {
  if (rule.from.startsWith(ABSOLUTE_URL_PREFIX)) {
    return false;
  }
  if (rule.from.endsWith(WILDCARD_SUFFIX)) {
    const prefix = rule.from.slice(0, -WILDCARD_SUFFIX.length);
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
  const relativePath = path.replace(/^\/+/, "");
  if (relativePath === "" || relativePath.endsWith("/")) {
    return [posix.join(relativePath, INDEX_HTML_FILE)];
  }
  return [relativePath];
}

function fileExistsInOutput(outDir: string, path: string): boolean {
  return candidateFiles(path).some((candidate) => {
    const absolute = resolve(outDir, candidate);
    if (!absolute.startsWith(resolve(outDir) + sep)) {
      return false;
    }
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
  if (rule.status >= CLIENT_ERROR_STATUS_FLOOR) {
    return `rule ${rule.from} responds with status ${rule.status}`;
  }
  const target = toInternalPath(
    rule.to.replace(SPLAT_PLACEHOLDER, splatFor(rule, path)),
    path,
  );
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

// These two files are the hand-maintained sources this check exists for, so a
// rename or deletion must fail loudly instead of silently skipping them.
function readRequired(outDir: string, file: string): string {
  const contents = readOptional(join(outDir, file));
  if (contents === undefined) {
    throw new Error(`Expected ${file} in build output at ${outDir}`);
  }
  return contents;
}

function toReferences(source: string, urls: string[]): LinkReference[] {
  return urls.map((url) => ({ source, url }));
}

function collectHtmlReferences(outDir: string): LinkReference[] {
  return listHtmlFiles(outDir).flatMap((file) => {
    const source = relative(outDir, file).split(sep).join("/");
    const html = readFileSync(file, "utf8");
    return toReferences(source, [
      ...extractHtmlUrls(html),
      ...extractSrcsetUrls(html),
      ...extractImageMetaUrls(html),
    ]);
  });
}

function collectManifestReferences(outDir: string): LinkReference[] {
  const manifest = readRequired(outDir, MANIFEST_FILE);
  try {
    return toReferences(MANIFEST_FILE, extractManifestIconUrls(manifest));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${MANIFEST_FILE}: ${reason}`, {
      cause: error,
    });
  }
}

function collectLlmsReferences(outDir: string): LinkReference[] {
  const llms = readRequired(outDir, LLMS_FILE);
  return toReferences(LLMS_FILE, extractLlmsUrls(llms));
}

export function collectReferences(outDir: string): LinkReference[] {
  return [
    ...collectHtmlReferences(outDir),
    ...collectManifestReferences(outDir),
    ...collectLlmsReferences(outDir),
  ];
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
  const toml = readOptional(netlifyTomlPath);
  if (toml === undefined) {
    throw new Error(`netlify.toml not found at ${netlifyTomlPath}`);
  }
  const rules = parseNetlifyRedirects(toml);
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
