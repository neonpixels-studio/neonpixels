import { createHash } from "node:crypto";

// Pure helpers for the script-src hashing rollout. Nothing here touches the
// filesystem, so the extraction and header-building logic is unit-testable in
// isolation; the build-time FS work lives in writeReportOnlyHeaders.ts.

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=/i;
const TYPE_ATTRIBUTE_PATTERN = /\btype\s*=\s*["']?([^"'\s>]+)/i;

// script-src governs only scripts the browser executes as JavaScript. A classic
// script (no type) and a module script run; a non-JS type such as
// application/ld+json is an inert data block the browser never executes, so
// hashing it would ship a dead source. An empty string is the no-type default.
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
]);

const SHA256_SOURCE_PREFIX = "sha256-";
const SCRIPT_SRC_DIRECTIVE = "script-src";
const SELF_SOURCE = "'self'";
const UNSAFE_INLINE_SOURCE = "'unsafe-inline'";
const DIRECTIVE_SEPARATOR = "; ";

type Directive = { name: string; sources: string[] };

function scriptType(attributes: string) {
  const match = attributes.match(TYPE_ATTRIBUTE_PATTERN);
  if (!match) {
    return "";
  }
  return match[1].toLowerCase();
}

// An inline script the browser executes: it has no src (external fetch, covered
// by host sources rather than a hash) and carries an executable type.
function isExecutableInlineScript(attributes: string) {
  if (SRC_ATTRIBUTE_PATTERN.test(attributes)) {
    return false;
  }
  return EXECUTABLE_SCRIPT_TYPES.has(scriptType(attributes));
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
  const hashes = new Set<string>();
  for (const html of htmlDocuments) {
    for (const body of extractInlineScriptBodies(html)) {
      hashes.add(sha256Source(body));
    }
  }
  return [...hashes].sort();
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

// Drop 'unsafe-inline' (a hash and 'unsafe-inline' are mutually exclusive per
// CSP: once a hash is present the browser ignores 'unsafe-inline') and add the
// build's inline-script hashes, preserving any other existing sources.
function lockDownScriptSrc(sources: string[], scriptHashes: string[]) {
  const kept = sources.filter(
    (source) => source.toLowerCase() !== UNSAFE_INLINE_SOURCE,
  );
  return [...kept, ...scriptHashes];
}

function isScriptSrc({ name }: Directive) {
  return name.toLowerCase() === SCRIPT_SRC_DIRECTIVE;
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
        sources: [SELF_SOURCE, ...scriptHashes],
      }),
    );
  }
  return rebuilt.join(DIRECTIVE_SEPARATOR);
}
