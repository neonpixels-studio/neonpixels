import { describe, it, expect } from "vitest";

import { getNoindexHeaderLines } from "../../robots/getNoindexHeaderLines";

const NOINDEX_HEADER_LINE = "X-Robots-Tag: noindex";

describe("getNoindexHeaderLines", () => {
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
