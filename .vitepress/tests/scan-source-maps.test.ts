import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertBuildOutputHasNoSourceMaps,
  hasSourceMappingUrlComment,
  scanBuildOutputForSourceMaps,
} from "../scan-source-maps";

const createdDirectories: string[] = [];

function makeDistDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "grimicorn-maps-"));
  createdDirectories.push(directory);
  return directory;
}

function writeFile(directory: string, relativePath: string, contents: string) {
  const target = join(directory, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hasSourceMappingUrlComment", () => {
  it("matches JS and CSS reference comments", () => {
    expect(
      hasSourceMappingUrlComment("a();\n//# sourceMappingURL=a.js.map"),
    ).toBe(true);
    expect(
      hasSourceMappingUrlComment("a{}\n/*# sourceMappingURL=a.css.map */"),
    ).toBe(true);
  });

  it("matches the legacy //@ form", () => {
    expect(
      hasSourceMappingUrlComment("a();\n//@ sourceMappingURL=a.js.map"),
    ).toBe(true);
  });

  it("matches a comment on the same line as minified code", () => {
    expect(
      hasSourceMappingUrlComment("a{}/*# sourceMappingURL=a.css.map */"),
    ).toBe(true);
  });

  it("matches an inline data-URI map", () => {
    expect(
      hasSourceMappingUrlComment(
        "a();\n//# sourceMappingURL=data:application/json;base64,e30=",
      ),
    ).toBe(true);
  });

  it("ignores a bare mention inside a bundled string", () => {
    expect(
      hasSourceMappingUrlComment('const note = "sourceMappingURL=";'),
    ).toBe(false);
  });
});

describe("scanBuildOutputForSourceMaps", () => {
  it("finds nothing in a clean build output", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "index.html", "<p>ok</p>");
    writeFile(directory, "assets/app.js", "console.log('ok')");
    expect(scanBuildOutputForSourceMaps(directory)).toEqual([]);
  });

  it("flags a leftover .map file in nested output", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "assets/chunks/app.js.map", "{}");
    expect(scanBuildOutputForSourceMaps(directory)).toEqual([
      { file: join(directory, "assets/chunks/app.js.map"), reason: "map file" },
    ]);
  });

  it("flags a sourceMappingURL comment even when the map was deleted", () => {
    const directory = makeDistDirectory();
    writeFile(
      directory,
      "assets/app.js",
      "a();\n//# sourceMappingURL=app.js.map",
    );
    expect(scanBuildOutputForSourceMaps(directory)).toEqual([
      {
        file: join(directory, "assets/app.js"),
        reason: "sourceMappingURL comment",
      },
    ]);
  });
});

describe("scanBuildOutputForSourceMaps file types", () => {
  const COMMENT = "/*# sourceMappingURL=app.css.map */";

  it("reads css files", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "assets/app.css", COMMENT);
    expect(scanBuildOutputForSourceMaps(directory)).toHaveLength(1);
  });

  it("reads mjs files", () => {
    const directory = makeDistDirectory();
    writeFile(
      directory,
      "assets/app.mjs",
      "a();\n//# sourceMappingURL=app.mjs.map",
    );
    expect(scanBuildOutputForSourceMaps(directory)).toHaveLength(1);
  });

  it("reads html files, where an inline script could carry a map", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "index.html", COMMENT);
    expect(scanBuildOutputForSourceMaps(directory)).toHaveLength(1);
  });

  it("skips file types that are not scripts, styles or pages", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "notes.txt", COMMENT);
    expect(scanBuildOutputForSourceMaps(directory)).toEqual([]);
  });
});

describe("assertBuildOutputHasNoSourceMaps", () => {
  it("passes on a clean build output", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "assets/app.js", "console.log('ok')");
    expect(() => assertBuildOutputHasNoSourceMaps(directory)).not.toThrow();
  });

  it("fails the build on a leftover map, naming the file", () => {
    const directory = makeDistDirectory();
    writeFile(directory, "assets/app.js.map", "{}");
    expect(() => assertBuildOutputHasNoSourceMaps(directory)).toThrow(
      /app\.js\.map/,
    );
  });
});
