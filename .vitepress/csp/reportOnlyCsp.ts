import { createHash } from "node:crypto";

// Pure helpers for the script-src hashing rollout. Nothing here touches the
// filesystem, so the extraction and header-building logic is unit-testable in
// isolation; the build-time FS work lives in writeReportOnlyHeaders.ts.

// Quote-aware attribute segment (the fallback class excludes the quote chars so
// the alternation has one unambiguous parse and can't catastrophically backtrack)
// and a whitespace-tolerant end tag (`</script >` is legal HTML) so a stray `>`
// inside an attribute value can never truncate the tag and split the hashed body.
const SCRIPT_TAG_PATTERN =
  /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi;
// One name="value" / name='value' / bare-name / name=value attribute. Reading
// name and value as a unit is what stops a `src=`/`type=` substring living inside
// another attribute's value (e.g. data-config="… src=x") from misclassifying the
// script — the risky, page-breaking direction (a missed hash).
const ATTRIBUTE_PATTERN = /([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const SRC_ATTRIBUTE = "src";
const TYPE_ATTRIBUTE = "type";

// script-src governs every <script> the browser executes as JavaScript, which is
// almost all of them: classic, module, importmap, MIME aliases. Only a few types
// are inert data blocks the browser never runs (application/ld+json is the one
// VitePress emits). Deny-listing the inert types means an unrecognized type errs
// toward a spare, harmless hash rather than a missing one that would break the
// page once 'unsafe-inline' is dropped at enforcement.
const INERT_SCRIPT_TYPES = new Set([
  "application/ld+json",
  "application/json",
  "text/template",
  "text/html",
]);

const SHA256_SOURCE_PREFIX = "sha256-";
const REPORT_URI_DIRECTIVE = "report-uri";
const REPORT_TO_DIRECTIVE = "report-to";
const SCRIPT_SRC_DIRECTIVE = "script-src";
const DEFAULT_SRC_DIRECTIVE = "default-src";
const SELF_SOURCE = "'self'";
const NONE_SOURCE = "'none'";
const UNSAFE_INLINE_SOURCE = "'unsafe-inline'";
const DIRECTIVE_SEPARATOR = "; ";
const MIME_PARAMETER_SEPARATOR = ";";

// 'none' and 'unsafe-inline' are both discarded once a hash is present: a hash
// makes 'unsafe-inline' a no-op, and a source list is either exactly 'none' or a
// list of sources — never both, so keeping 'none' alongside a hash is invalid.
const HASH_INCOMPATIBLE_SOURCES = new Set([NONE_SOURCE, UNSAFE_INLINE_SOURCE]);

type Directive = { name: string; sources: string[] };

function parseAttributes(attributes: string) {
  const parsed = new Map<string, string>();
  for (const match of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase();
    const rawValue = match[2] ?? "";
    parsed.set(name, rawValue.replace(/^["']|["']$/g, ""));
  }
  return parsed;
}

// The bare MIME type, lowercased, with any parameters (e.g. `;charset=utf-8`)
// stripped so `text/javascript;charset=utf-8` classifies as `text/javascript`.
function scriptType(attributes: Map<string, string>) {
  const rawType = attributes.get(TYPE_ATTRIBUTE) ?? "";
  return rawType.split(MIME_PARAMETER_SEPARATOR)[0].trim().toLowerCase();
}

// An inline script the browser executes: it has no src (external fetch, covered
// by host sources rather than a hash) and is not an inert data type.
function isExecutableInlineScript(attributes: string) {
  const parsed = parseAttributes(attributes);
  if (parsed.has(SRC_ATTRIBUTE)) {
    return false;
  }
  return !INERT_SCRIPT_TYPES.has(scriptType(parsed));
}

// The exact textContent of every executable inline <script> in the HTML. The
// browser hashes these raw bytes; <script> is a raw-text element, so no entity
// decoding happens and the substring between the tags is what must be hashed.
export function extractInlineScriptBodies(html: string) {
  const bodies: string[] = [];
  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    if (!isExecutableInlineScript(match[1])) {
      continue;
    }
    if (match[2].trim() === "") {
      continue;
    }
    bodies.push(match[2]);
  }
  return bodies;
}

// A single CSP hash-source for the script body, e.g. 'sha256-...'. The digest is
// base64 over the UTF-8 bytes, matching how the browser derives it.
export function sha256Source(scriptBody: string) {
  const digest = createHash("sha256")
    .update(scriptBody, "utf8")
    .digest("base64");
  return `'${SHA256_SOURCE_PREFIX}${digest}'`;
}

// Every distinct inline-script hash across the given HTML documents, sorted for a
// stable, diffable header. Deduped so shared bootstrap scripts count once.
export function collectInlineScriptHashes(htmlDocuments: string[]) {
  const hashes = htmlDocuments
    .flatMap(extractInlineScriptBodies)
    .map(sha256Source);
  return [...new Set(hashes)].sort();
}

function parseDirectives(csp: string): Directive[] {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const tokens = directive.split(/\s+/);
      return { name: tokens[0], sources: tokens.slice(1) };
    });
}

function formatDirective({ name, sources }: Directive) {
  return [name, ...sources].join(" ");
}

// Add the build's inline-script hashes, dropping sources a hash makes invalid or
// redundant ('none', 'unsafe-inline') while preserving every other source. With
// no hashes to add, only 'unsafe-inline' is dropped so a bare 'self'/'none' base
// survives unchanged.
function lockDownScriptSrc(sources: string[], scriptHashes: string[]) {
  const discarded = scriptHashes.length
    ? HASH_INCOMPATIBLE_SOURCES
    : new Set([UNSAFE_INLINE_SOURCE]);
  const kept = sources.filter((source) => !discarded.has(source.toLowerCase()));
  return [...kept, ...scriptHashes];
}

function isScriptSrc({ name }: Directive) {
  return name.toLowerCase() === SCRIPT_SRC_DIRECTIVE;
}

function isDefaultSrc({ name }: Directive) {
  return name.toLowerCase() === DEFAULT_SRC_DIRECTIVE;
}

// When the enforcing policy declares no script-src it inherits default-src, so a
// synthesized script-src starts from those same sources rather than fabricating a
// more permissive 'self'. Falls back to 'self' only when neither directive
// exists. lockDownScriptSrc then drops the hash-incompatible sources.
function scriptSrcBaseSources(directives: Directive[]) {
  const defaultSrc = directives.find(isDefaultSrc);
  if (!defaultSrc) {
    return [SELF_SOURCE];
  }
  return defaultSrc.sources;
}

// The Report-Only policy: the enforcing CSP verbatim, except script-src trades
// 'unsafe-inline' for the build's inline-script hashes. Every other directive is
// untouched, so the browser reports (never blocks) only genuine script-src drift.
export function buildReportOnlyCsp(
  enforcingCsp: string,
  scriptHashes: string[],
) {
  const directives = parseDirectives(enforcingCsp);
  const rebuilt = directives.map((directive) => {
    if (!isScriptSrc(directive)) {
      return formatDirective(directive);
    }
    return formatDirective({
      name: directive.name,
      sources: lockDownScriptSrc(directive.sources, scriptHashes),
    });
  });
  if (!directives.some(isScriptSrc)) {
    rebuilt.push(
      formatDirective({
        name: SCRIPT_SRC_DIRECTIVE,
        sources: lockDownScriptSrc(
          scriptSrcBaseSources(directives),
          scriptHashes,
        ),
      }),
    );
  }
  return rebuilt.join(DIRECTIVE_SEPARATOR);
}

// Point the Report-Only policy at the violation collector so reports are
// delivered, not just console-logged. `report-to` is the modern Reporting API
// path — it names a group defined by a companion Reporting-Endpoints header —
// while `report-uri` is the deprecated directive Firefox and older engines still
// require, pointing straight at the collector path. Both are appended so a
// violation is gathered regardless of which the browser honours.
export function withReportingDirectives(
  csp: string,
  reportingGroup: string,
  collectorPath: string,
) {
  return [
    csp,
    `${REPORT_URI_DIRECTIVE} ${collectorPath}`,
    `${REPORT_TO_DIRECTIVE} ${reportingGroup}`,
  ].join(DIRECTIVE_SEPARATOR);
}
