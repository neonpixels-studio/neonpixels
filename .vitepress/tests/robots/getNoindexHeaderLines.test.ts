import { describe, it, expect, afterEach, beforeEach } from "vitest";

import { getNoindexHeaderLines } from "../../robots/getNoindexHeaderLines";

const NOINDEX_HEADER_LINE = "X-Robots-Tag: noindex";

describe("getNoindexHeaderLines", () => {
  // Passing `undefined` explicitly for the "unset CONTEXT" case still triggers
  // the function's default parameter, which reads the ambient
  // `process.env.CONTEXT` — so this suite must control that ambient value the
  // same way config.test.ts does, or "an unset CONTEXT" silently asserts on
  // whatever CONTEXT happens to be set in the calling environment (e.g. a real
  // Netlify deploy-preview build, where it would wrongly expect no lines).
  const ORIGINAL_CONTEXT = process.env.CONTEXT;

  beforeEach(() => {
    delete process.env.CONTEXT;
  });

  afterEach(() => {
    if (ORIGINAL_CONTEXT === undefined) {
      delete process.env.CONTEXT;
      return;
    }
    process.env.CONTEXT = ORIGINAL_CONTEXT;
  });

  it.each(["deploy-preview", "branch-deploy"])(
    "returns the noindex line for the %s context",
    (context) => {
      expect(getNoindexHeaderLines(context)).toEqual([NOINDEX_HEADER_LINE]);
    },
  );

  it.each([
    ["production", "production"],
    ["local netlify dev", "dev"],
    ["an unset CONTEXT", undefined],
    ["an unrecognised context", "some-future-context"],
  ])("returns no lines for %s", (_label, context) => {
    expect(getNoindexHeaderLines(context)).toEqual([]);
  });
});
