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
// isRolloutKey. cspReportSummary.ts re-exports both so existing callers of
// the read/aggregation path are unaffected.
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

// Tag embedded in every stored key (see violationKey) so the pruner can tell
// a rollout-relevant violation from any other report using only what list()
// already returns — a get()-per-key classification pass would blow the
// pruner's own time budget on a store large enough to need pruning (see
// cspReportPruner.ts). This is what closes #135: the endpoint is public and
// unauthenticated, so an attacker can flood it with fabricated non-script-src
// reports; without a way to tell them apart from list() alone, the hourly
// pruner's count-cap pass would evict genuine script-src evidence
// oldest-first right alongside the flood, sometimes before the daily summary
// ever reads it, producing a false "stopped: true" rollout signal.
const ROLLOUT_KEY_TAG = "rollout";
const OTHER_KEY_TAG = "other";

function directiveTag(violation: CspViolation): string {
  return isRolloutDirective(violation.effectiveDirective)
    ? ROLLOUT_KEY_TAG
    : OTHER_KEY_TAG;
}

// Fixed-width-prefix, then a fixed-set tag, then the uuid: cspReportPruner.ts
// already slices a fixed-length timestamp prefix off the front of every key
// (see RECEIVED_AT_PREFIX_LENGTH there) to sort chronologically without
// parsing back to a Date; the tag rides directly after that prefix so it can
// be read with the same kind of plain string slice, not a full parse.
function violationKey(receivedAt: string, violation: CspViolation): string {
  return `${sanitizeTimestamp(receivedAt)}-${directiveTag(violation)}-${randomUUID()}.json`;
}

// Exported so cspReportPruner.ts can classify a listed key without a Blobs
// get() per key. Deliberately permissive about anything before the ROLLOUT_
// KEY_TAG segment isn't matched: a key written before this tagging existed
// (or a future format change) falls back to "not rollout", the safer
// direction — it can still be evicted by the count cap like today, rather
// than being silently granted unbounded protection it was never tagged for.
export function isRolloutKey(key: string): boolean {
  return key
    .slice(RECEIVED_AT_PREFIX_LENGTH)
    .startsWith(`-${ROLLOUT_KEY_TAG}-`);
}

// Keys are `<sanitized ISO receivedAt>-<tag>-<uuid>.json`. The sanitized
// timestamp is fixed-width, so this is how both this module and
// cspReportPruner.ts locate where the timestamp ends and the tag begins,
// without parsing each key back into a Date. Exported so the pruner and this
// module can never drift apart on what "the timestamp part" means.
export const RECEIVED_AT_PREFIX_LENGTH = sanitizeTimestamp(
  new Date(0).toISOString(),
).length;

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
