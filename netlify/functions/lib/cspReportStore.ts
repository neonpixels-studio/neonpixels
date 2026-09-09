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
// separators (`:` and `.`) that aren't already dashes.
function violationKey(receivedAt: string): string {
  const sanitizedTimestamp = receivedAt.replace(/[:.]/g, "-");
  return `${sanitizedTimestamp}-${randomUUID()}.json`;
}

function writeViolation(blobWriter: BlobWriter, receivedAt: string) {
  return (violation: CspViolation) => {
    const stored: StoredCspViolation = { ...violation, receivedAt };
    return blobWriter.setJSON(violationKey(receivedAt), stored);
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
