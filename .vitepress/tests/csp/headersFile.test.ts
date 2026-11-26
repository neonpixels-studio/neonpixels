import { describe, expect, it } from "vitest";

import { parseHeadersFile } from "../../csp/headersFile";

describe("parseHeadersFile", () => {
  it("groups indented headers under the path above them", () => {
    const blocks = parseHeadersFile(
      "/assets/*\n  Cache-Control: public, immutable\n\n/*\n  X-A: 1\n  X-B: two words",
    );
    expect(blocks).toEqual([
      {
        path: "/assets/*",
        headers: [{ name: "Cache-Control", value: "public, immutable" }],
      },
      {
        path: "/*",
        headers: [
          { name: "X-A", value: "1" },
          { name: "X-B", value: "two words" },
        ],
      },
    ]);
  });

  it("skips comments, blank lines and a path with no headers still counts as a block", () => {
    const blocks = parseHeadersFile(
      "# note\n\n/empty\n  # inner note\n/*\n  X-A: 1",
    );
    expect(blocks.map((block) => block.path)).toEqual(["/empty", "/*"]);
    expect(blocks[0].headers).toEqual([]);
  });

  it("keeps a colon inside a value", () => {
    const [block] = parseHeadersFile(
      '/*\n  Reporting-Endpoints: g="https://a.test:8080/x"',
    );
    expect(block.headers[0].value).toBe('g="https://a.test:8080/x"');
  });

  it("throws on an indented line that is not a header", () => {
    expect(() => parseHeadersFile("/*\n  X-A:")).toThrow(
      /not a valid header line/,
    );
  });

  it("throws on an indented header with no path above it", () => {
    expect(() => parseHeadersFile("  X-A: 1")).toThrow(
      /not a valid header line/,
    );
  });
});
