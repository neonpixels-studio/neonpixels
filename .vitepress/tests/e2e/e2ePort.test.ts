import { describe, it, expect } from "vitest";
import { readE2ePort } from "../../../e2e/support/e2ePort";

describe("readE2ePort", () => {
  it("defaults to 4321 when unset", () => {
    expect(readE2ePort(undefined)).toBe(4321);
  });

  it("accepts a valid override", () => {
    expect(readE2ePort("5000")).toBe(5000);
  });

  it.each(["", "abc", "0", "70000", "1.5"])("rejects %j", (rawPort) => {
    expect(() => readE2ePort(rawPort)).toThrow(/E2E_PORT/);
  });
});
