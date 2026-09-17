// Read/summary path for the csp-reports Blobs store, isolated from Netlify
// Blobs the same way cspReportStore.ts (write) and cspReportPruner.ts
// (retention) isolate their own seams. Neither of those answers the question
// the store exists for: which directives/blocked URIs are still firing, and
// specifically whether the script-src rollout's violations (see the `@todo`
// in netlify.toml and the README's CSP violation collector section) have
// actually stopped. `createCspReportSummary` takes anything shaped like the
// two Blobs methods it needs (list, get) so the aggregation is unit-tested
// without the Netlify runtime; `getCspReportSummary` is the only place that
// touches `@netlify/blobs`. The adapter that actually invokes this lives in
// ../csp-report-summary.ts (a scheduled Function, not a public route — see
// that file for why).
import { getStore } from "@netlify/blobs";

import { CSP_REPORT_STORE_NAME } from "./cspReportStore";
import type { StoredCspViolation } from "./cspReportStore";

export type BlobListEntry = { key: string };
export type BlobPage = { blobs: BlobListEntry[] };

// The two Blobs capabilities summarizing needs, so tests can inject a fake
// without mocking the `@netlify/blobs` module (mirrors `BlobWriter` in
// cspReportStore.ts and `BlobPrunerClient` in cspReportPruner.ts). `list` is
// typed to the `paginate: true` overload so the summary always walks every
// page, not just the first.
export type BlobSummaryClient = {
  list(_options: { paginate: true }): AsyncIterable<BlobPage>;
  get(_key: string, _options: { type: "json" }): Promise<unknown>;
};

// The directive this repo's rollout is watching. Once it stops firing over
// the observation window, `'unsafe-inline'` can be dropped from the
// enforcing `script-src` in netlify.toml.
export const ROLLOUT_DIRECTIVE = "script-src";

export type DirectiveCount = { directive: string; count: number };
export type BlockedUriCount = { blockedUri: string; count: number };

export type RolloutSignal = {
  directive: string;
  count: number;
  // null once `count` is 0 — nothing to point at.
  mostRecent: StoredCspViolation | null;
  stopped: boolean;
};

export type CspReportSummary = {
  // Every key the store listed, regardless of whether it fetched or parsed
  // successfully — the denominator for fetchFailures/invalidEntries below.
  totalListed: number;
  totalViolations: number;
  // Descending by count (ties broken alphabetically for a deterministic
  // order), so the loudest directive/URI is first without the caller
  // re-sorting.
  byDirective: DirectiveCount[];
  byBlockedUri: BlockedUriCount[];
  rollout: RolloutSignal;
  // A get() that threw for a listed key (network hiccup, evicted between
  // list and get, etc). Counted rather than thrown so one bad key can't
  // blank out an otherwise-good summary; logged via
  // csp-report-summary-fetch-failed so the gap is still visible.
  fetchFailures: number;
  // A key that fetched but didn't parse as a StoredCspViolation (a
  // corrupted blob, or a future incompatible shape). Logged via
  // csp-report-summary-invalid-entry for the same reason.
  invalidEntries: number;
};

export type CspReportSummaryTool = {
  summarize(): Promise<CspReportSummary>;
};

async function listAllKeys(client: BlobSummaryClient): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of client.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
  }
  return keys;
}

function isStoredCspViolation(value: unknown): value is StoredCspViolation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.documentUrl === "string" &&
    typeof record.effectiveDirective === "string" &&
    typeof record.blockedUri === "string" &&
    typeof record.receivedAt === "string"
  );
}

type FetchOutcome =
  | { status: "ok"; violation: StoredCspViolation }
  | { status: "invalid"; key: string }
  | { status: "failed"; key: string; reason: unknown };

async function fetchOne(
  client: BlobSummaryClient,
  key: string,
): Promise<FetchOutcome> {
  let raw: unknown;
  try {
    raw = await client.get(key, { type: "json" });
  } catch (reason) {
    return { status: "failed", key, reason };
  }
  if (isStoredCspViolation(raw)) {
    return { status: "ok", violation: raw };
  }
  return { status: "invalid", key };
}

const SUMMARY_FETCH_FAILED_LOG_PREFIX = "csp-report-summary-fetch-failed";
const SUMMARY_INVALID_ENTRY_LOG_PREFIX = "csp-report-summary-invalid-entry";

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function logFetchOutcome(outcome: FetchOutcome): void {
  if (outcome.status === "failed") {
    console.warn(
      SUMMARY_FETCH_FAILED_LOG_PREFIX,
      JSON.stringify({
        key: outcome.key,
        message: reasonMessage(outcome.reason),
      }),
    );
    return;
  }
  if (outcome.status === "invalid") {
    console.warn(
      SUMMARY_INVALID_ENTRY_LOG_PREFIX,
      JSON.stringify({ key: outcome.key }),
    );
  }
}

function isOk(
  outcome: FetchOutcome,
): outcome is Extract<FetchOutcome, { status: "ok" }> {
  return outcome.status === "ok";
}

// Counts violations by an arbitrary field, then orders the result descending
// by count (alphabetically on a tie) so both the directive and blocked-uri
// breakdowns share one sort rule instead of drifting apart.
function sortedCountsBy(
  violations: StoredCspViolation[],
  keyOf: (_violation: StoredCspViolation) => string,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const key = keyOf(violation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function aggregateByDirective(
  violations: StoredCspViolation[],
): DirectiveCount[] {
  return sortedCountsBy(
    violations,
    (violation) => violation.effectiveDirective,
  ).map(({ key, count }) => ({ directive: key, count }));
}

function aggregateByBlockedUri(
  violations: StoredCspViolation[],
): BlockedUriCount[] {
  return sortedCountsBy(violations, (violation) => violation.blockedUri).map(
    ({ key, count }) => ({ blockedUri: key, count }),
  );
}

// Browsers report the specific sub-directive a violation matched
// (script-src-elem, script-src-attr) even when only the parent script-src is
// declared in the policy — this site's CSP never sets those sub-directives
// separately (see netlify.toml), so any of the three is evidence against the
// same script-src rollout. An exact-match-only check would silently miss
// most real violations and falsely read the rollout as clean.
function isRolloutDirective(directive: string): boolean {
  return (
    directive === ROLLOUT_DIRECTIVE ||
    directive.startsWith(`${ROLLOUT_DIRECTIVE}-`)
  );
}

// Most-recent-first so the rollout signal can report the latest offending
// violation without re-deriving it. `receivedAt` is an ISO timestamp, so a
// plain string comparison orders it correctly without parsing to a Date
// (mirrors the trick cspReportPruner.ts uses on the sanitized key).
function mostRecentFirst(
  violations: StoredCspViolation[],
): StoredCspViolation[] {
  return [...violations].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

function summarizeRollout(violations: StoredCspViolation[]): RolloutSignal {
  const matches = violations.filter((violation) =>
    isRolloutDirective(violation.effectiveDirective),
  );
  return {
    directive: ROLLOUT_DIRECTIVE,
    count: matches.length,
    mostRecent: mostRecentFirst(matches)[0] ?? null,
    stopped: matches.length === 0,
  };
}

// Pure factory: given anything that can list and get blobs, returns a tool
// that reads every stored violation and aggregates it. Unlike the pruner,
// this has no time budget — it's a human-invoked query, not a Function
// bound by Netlify's execution limit.
export function createCspReportSummary(
  client: BlobSummaryClient,
): CspReportSummaryTool {
  return {
    async summarize() {
      const keys = await listAllKeys(client);
      const outcomes = await Promise.all(
        keys.map((key) => fetchOne(client, key)),
      );
      for (const outcome of outcomes) {
        logFetchOutcome(outcome);
      }
      const violations = outcomes
        .filter(isOk)
        .map((outcome) => outcome.violation);
      return {
        totalListed: keys.length,
        totalViolations: violations.length,
        byDirective: aggregateByDirective(violations),
        byBlockedUri: aggregateByBlockedUri(violations),
        rollout: summarizeRollout(violations),
        fetchFailures: outcomes.filter((outcome) => outcome.status === "failed")
          .length,
        invalidEntries: outcomes.filter(
          (outcome) => outcome.status === "invalid",
        ).length,
      };
    },
  };
}

// The concrete adapter the scheduled Function (../csp-report-summary.ts)
// uses. Netlify auto-configures Blobs (siteID/token injected via env) for
// deployed Functions and `netlify dev`, so no new environment variables are
// required; `getStore` only throws if that context is missing, which the
// adapter catches and logs rather than crashing the run.
export function getCspReportSummary(): CspReportSummaryTool {
  return createCspReportSummary(getStore(CSP_REPORT_STORE_NAME));
}
