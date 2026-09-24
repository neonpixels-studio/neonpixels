// Persistence for CSP violations, isolated from Netlify Blobs so the write
// path is unit-testable without the Netlify runtime. `createCspReportStore`
// takes anything shaped like the one Blobs method it needs; `getCspReportStore`
// is the only place that touches `@netlify/blobs`, and is the seam a test
// replaces to avoid the real network/storage call.
import { randomUUID } from "node:crypto";

import { getStore } from "@netlify/blobs";

import type { CspViolation } from "../../../.vitepress/csp/cspReportCollector";

// Netlify Blobs store name the collector's violations are written under.
// Distinct from any other store the site might add later.
export const CSP_REPORT_STORE_NAME = "csp-reports";

// A violation as written to Blobs: the normalized fields plus when the
// collector received it, so entries can be ordered/filtered without relying
// on Blobs' own metadata.
export type StoredCspViolation = CspViolation & { receivedAt: string };

// The one Blobs capability the store needs, so tests can inject a fake
// without mocking the `@netlify/blobs` module.
export type BlobWriter = {
  setJSON(_key: string, _value: unknown): Promise<unknown>;
};

export type CspReportStore = {
  persist(_violations: CspViolation[]): Promise<void>;
};

// Netlify's production Blobs backend accepts a raw ISO timestamp, but
// `netlify dev` materializes blobs on the local filesystem and most shell/CLI
// tooling doesn't expect `:` in a path segment, so replace the ISO
// separators (`:` and `.`) that aren't already dashes. Exported so
// cspReportPruner.ts can compute a same-format cutoff and compare it
// lexicographically against stored keys, without parsing each key back into
// a Date.
export function sanitizeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

// The directive this repo's rollout is watching. Once it stops firing over
// the observation window, `'unsafe-inline'` can be dropped from the
// enforcing `script-src` in netlify.toml. Owned here (the key-encoding
// module) rather than in cspReportSummary.ts, because the write path below
// now needs the same classification to tag each stored key — see
// isRolloutKey and #135. cspReportSummary.ts imports both from here.
export const ROLLOUT_DIRECTIVE = "script-src";

// Browsers report the specific sub-directive a violation matched
// (script-src-elem, script-src-attr) even when only the parent script-src is
// declared in the policy — this site's CSP never sets those sub-directives
// separately (see netlify.toml), so any of the three is evidence against the
// same script-src rollout. An exact-match-only check would silently miss
// most real violations.
export function isRolloutDirective(directive: string): boolean {
  return (
    directive === ROLLOUT_DIRECTIVE ||
    directive.startsWith(`${ROLLOUT_DIRECTIVE}-`)
  );
}

// Keys are `<sanitized ISO receivedAt>-<tag>-<uuid>.json`. The sanitized
// timestamp is fixed-width, so this is how both this module and
// cspReportPruner.ts locate where the timestamp ends and the tag begins,
// without parsing each key back into a Date. Exported so the pruner and this
// module can never drift apart on what "the timestamp part" means. Declared
// before the functions that read it (violationKey, isRolloutKey) so those
// read top-to-bottom.
export const RECEIVED_AT_PREFIX_LENGTH = sanitizeTimestamp(
  new Date(0).toISOString(),
).length;

// Only OTHER_KEY_TAG is matched against explicitly (see isRolloutKey) — a
// key tagged ROLLOUT_KEY_TAG and an untagged legacy key (written before this
// tagging existed) both end up treated as rollout, so the two constants
// aren't symmetric consumers of the same check. ROLLOUT_KEY_TAG still exists
// so a written key states its classification explicitly rather than only by
// omission, which matters for reading raw Blobs keys during an incident.
const ROLLOUT_KEY_TAG = "rollout";
const OTHER_KEY_TAG = "other";
type KeyTag = typeof ROLLOUT_KEY_TAG | typeof OTHER_KEY_TAG;

// Tag embedded in every stored key (see violationKey) so the pruner can tell
// a rollout-relevant violation from any other report using only what list()
// already returns — a get()-per-key classification pass would blow the
// pruner's own time budget on a store large enough to need pruning (see
// cspReportPruner.ts and overCapKeys there for what this buys against the
// #135 eviction-flood). The tag is derived from the violation's own
// self-reported `effectiveDirective`, the same field browsers (and anyone
// posting to this public, unauthenticated endpoint) supply — this narrows
// the flood this defends against to one that doesn't also forge the
// directive; it is not a forgery-proof boundary, the same tradeoff
// isOwnOriginViolation documents in csp-report.ts for `documentUrl`. The
// fail-closed gate in summarizeRollout (cspReportSummary.ts) is what still
// holds even against a directive-forging flood.
function directiveTag(violation: CspViolation): KeyTag {
  return isRolloutDirective(violation.effectiveDirective)
    ? ROLLOUT_KEY_TAG
    : OTHER_KEY_TAG;
}

// Fixed-width-prefix, then a fixed-set tag, then the uuid: the tag rides
// directly after RECEIVED_AT_PREFIX_LENGTH so it can be read with a plain
// string slice (see isRolloutKey), not a full parse.
function violationKey(receivedAt: string, violation: CspViolation): string {
  return `${sanitizeTimestamp(receivedAt)}-${directiveTag(violation)}-${randomUUID()}.json`;
}

// A legacy key predates the `-<tag>-` segment: just `-<uuid>.json` straight
// after the timestamp (see violationKey's shape before this tagging
// existed). Matched positively, rather than "not other", so only the two
// shapes this module has ever actually written classify as rollout by
// default — see isRolloutKey below for why that distinction matters.
const LEGACY_UNTAGGED_KEY_SUFFIX = /^-[0-9a-f-]{36}\.json$/;

// Exported so cspReportPruner.ts can classify a listed key without a Blobs
// get() per key. Rollout-tagged and legacy-untagged keys (written before
// this tagging existed) both count as rollout — the safer default for
// evidence the pruner can't positively rule out as irrelevant, bounded by
// retention (ages every key out regardless of tag) and by overCapKeys' spill
// branch (still trims to maxBlobs once every `other`-tagged key is gone).
// Anything matching neither known shape — a future format, a different
// producer, a truncated/corrupted key — falls to `other` instead of
// inheriting that protection by default: unlike a legacy key (a shape this
// module wrote and fully understands), an unrecognized one isn't provably
// safe to protect, and defaulting it to "protected" would make it
// permanently unprunable by the count cap. See README, csp-reports section,
// for the fuller trade-off.
export function isRolloutKey(key: string): boolean {
  const suffix = key.slice(RECEIVED_AT_PREFIX_LENGTH);
  return (
    suffix.startsWith(`-${ROLLOUT_KEY_TAG}-`) ||
    LEGACY_UNTAGGED_KEY_SUFFIX.test(suffix)
  );
}

function writeViolation(blobWriter: BlobWriter, receivedAt: string) {
  return (violation: CspViolation) => {
    const stored: StoredCspViolation = { ...violation, receivedAt };
    return blobWriter.setJSON(violationKey(receivedAt, violation), stored);
  };
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

// Every distinct failure reason in the batch, so a mix of causes (e.g. one
// bad key, the rest a quota error) isn't collapsed into just the first one.
function describeFailures(failures: PromiseRejectedResult[]): string {
  const reasons = new Set(failures.map((failure) => String(failure.reason)));
  return [...reasons].join("; ");
}

// Pure factory: given anything that can write a JSON blob, returns a store
// that fans a batch of violations out to one blob per violation (so each is
// independently listable/queryable rather than buried in a combined batch
// object).
export function createCspReportStore(blobWriter: BlobWriter): CspReportStore {
  return {
    async persist(violations) {
      if (violations.length === 0) {
        return;
      }
      const receivedAt = new Date().toISOString();
      const results = await Promise.allSettled(
        violations.map(writeViolation(blobWriter, receivedAt)),
      );
      const failures = results.filter(isRejected);
      if (failures.length === 0) {
        return;
      }
      throw new Error(
        `${failures.length}/${results.length} csp violation writes failed: ${describeFailures(failures)}`,
      );
    },
  };
}

// The concrete adapter the Netlify function uses. Netlify auto-configures
// Blobs (siteID/token injected via env) in production and `netlify dev`, so
// no new environment variables are required; `getStore` only throws if that
// context is missing, which the adapter catches and logs rather than failing
// the request.
export function getCspReportStore(): CspReportStore {
  return createCspReportStore(getStore(CSP_REPORT_STORE_NAME));
}
