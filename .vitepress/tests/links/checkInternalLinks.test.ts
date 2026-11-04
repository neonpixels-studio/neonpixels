import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  extractHtmlUrls,
  extractLlmsUrls,
  extractManifestIconUrls,
  findBrokenReferences,
  parseNetlifyRedirects,
  runInternalLinkCheckCli,
  toInternalPath,
} from "../../links/checkInternalLinks";

const TOML = `
[build]
  publish = ".vitepress/dist"

[[redirects]]
  from = "https://neonpixels.io/*"
  to = "https://neonpixels.dev/:splat"
  status = 301
  force = true

[[redirects]]
  from = "/dashboard"
  to = "https://dashboard.neonpixels.dev"
  status = 301

[[redirects]]
  from = "/dashboard/*"
  to = "https://dashboard.neonpixels.dev/:splat"
  status = 301

[[redirects]]
  from = "/privacy"
  to = "/privacy.html"
  status = 200

[[headers]]
  for = "/*"
`;

let workDir = "";
let outDir = "";
let tomlPath = "";

function writeOutput(relativePath: string, contents = "x") {
  const absolute = join(outDir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "link-check-"));
  outDir = join(workDir, "dist");
  mkdirSync(outDir);
  tomlPath = join(workDir, "netlify.toml");
  writeFileSync(tomlPath, TOML);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseNetlifyRedirects", () => {
  it("defaults a missing status to 301", () => {
    const [rule] = parseNetlifyRedirects(
      '[[redirects]]\n  from = "/a"\n  to = "/b"\n',
    );
    expect(rule.status).toBe(301);
  });

  it("reads every redirects block and ignores other sections", () => {
    const rules = parseNetlifyRedirects(TOML);
    expect(rules.map((rule) => rule.from)).toEqual([
      "https://neonpixels.io/*",
      "/dashboard",
      "/dashboard/*",
      "/privacy",
    ]);
    expect(rules[3]).toEqual({
      from: "/privacy",
      to: "/privacy.html",
      status: 200,
    });
  });
});

describe("extractors", () => {
  it("pulls href and src values from HTML", () => {
    const html = `<a href="/a">x</a><img src='/b.png'><link rel="x" href="#top">`;
    expect(extractHtmlUrls(html)).toEqual(["/a", "/b.png", "#top"]);
  });

  it("pulls manifest icon sources", () => {
    const manifest = JSON.stringify({ icons: [{ src: "/i.png" }, {}] });
    expect(extractManifestIconUrls(manifest)).toEqual(["/i.png"]);
  });

  it("pulls markdown link targets from llms.txt", () => {
    expect(
      extractLlmsUrls("- [Home](https://neonpixels.dev/): Landing"),
    ).toEqual(["https://neonpixels.dev/"]);
  });
});

describe("toInternalPath", () => {
  it("ignores external hosts, fragments and non-http schemes", () => {
    expect(toInternalPath("https://basin.fm", "/index.html")).toBeUndefined();
    expect(toInternalPath("//cdn.example/x.js", "/index.html")).toBeUndefined();
    expect(toInternalPath("#about", "/index.html")).toBeUndefined();
    expect(toInternalPath("mailto:a@b.c", "/index.html")).toBeUndefined();
  });

  it("strips query and hash and treats the site origin as internal", () => {
    expect(toInternalPath("/a.png?v=1#x", "/index.html")).toBe("/a.png");
    expect(toInternalPath("https://neonpixels.dev/privacy", "llms.txt")).toBe(
      "/privacy",
    );
  });

  it("treats plain http on the site host as external and a query-only URL as root", () => {
    expect(
      toInternalPath("http://neonpixels.dev/x", "/i.html"),
    ).toBeUndefined();
    expect(toInternalPath("https://neonpixels.dev?x=1", "/i.html")).toBe("/");
  });

  it("keeps an unparseable URL so it fails lookup instead of crashing", () => {
    expect(toInternalPath("http://", "/i.html")).toBe("http://");
  });

  it("keeps a malformed percent escape instead of throwing", () => {
    expect(toInternalPath("/a%E0%A4.png", "/i.html")).toBe("/a%E0%A4.png");
  });

  it("resolves relative URLs against the source page", () => {
    expect(toInternalPath("b.png", "/docs/page.html")).toBe("/docs/b.png");
  });
});

describe("findBrokenReferences", () => {
  const rules = parseNetlifyRedirects(TOML);

  it("flags a missing file and passes an existing one", () => {
    writeOutput("images/a.png");
    const broken = findBrokenReferences(
      outDir,
      [
        { source: "index.html", url: "/images/a.png?v=2" },
        { source: "index.html", url: "/images/gone.png" },
      ],
      rules,
    );
    expect(broken).toHaveLength(1);
    expect(broken[0].reference).toBe("/images/gone.png");
  });

  it("does not treat a rewrite as a free pass when its target is missing", () => {
    const references = [{ source: "index.html", url: "/privacy" }];
    expect(findBrokenReferences(outDir, references, rules)).toHaveLength(1);
    writeOutput("privacy.html");
    expect(findBrokenReferences(outDir, references, rules)).toHaveLength(0);
  });

  it("does not assume pretty URLs without a rule", () => {
    writeOutput("privacy.html");
    const references = [{ source: "index.html", url: "/privacy" }];
    expect(findBrokenReferences(outDir, references, [])).toHaveLength(1);
  });

  it("allows proxied or redirected external routes like /dashboard", () => {
    const references = [
      { source: "index.html", url: "/dashboard" },
      { source: "index.html", url: "/dashboard/settings" },
    ];
    expect(findBrokenReferences(outDir, references, rules)).toHaveLength(0);
  });

  it("substitutes the splat when validating an internal wildcard redirect", () => {
    const splatRules = parseNetlifyRedirects(
      '[[redirects]]\n  from = "/old/*"\n  to = "/new/:splat"\n  status = 301\n',
    );
    writeOutput("new/index.html");
    const references = [{ source: "index.html", url: "/old/a.png" }];
    expect(findBrokenReferences(outDir, references, splatRules)).toHaveLength(
      1,
    );
    writeOutput("new/a.png");
    expect(findBrokenReferences(outDir, references, splatRules)).toHaveLength(
      0,
    );
  });

  it("never probes outside the output directory", () => {
    writeFileSync(join(workDir, "secret.txt"), "x");
    const references = [{ source: "index.html", url: "/..%2Fsecret.txt" }];
    expect(findBrokenReferences(outDir, references, [])).toHaveLength(1);
  });

  it("resolves directory URLs to index.html", () => {
    writeOutput("index.html");
    const references = [{ source: "llms.txt", url: "https://neonpixels.dev/" }];
    expect(findBrokenReferences(outDir, references, rules)).toHaveLength(0);
  });
});

describe("runInternalLinkCheckCli", () => {
  function writeValidSite() {
    writeOutput(
      "index.html",
      `<a href="/privacy">p</a><img src="/images/a.png">`,
    );
    writeOutput("privacy.html", `<a href="/">home</a>`);
    writeOutput("images/a.png");
    writeOutput(
      "images/site.webmanifest",
      JSON.stringify({ icons: [{ src: "/images/a.png" }] }),
    );
    writeOutput("llms.txt", "- [Home](https://neonpixels.dev/): Landing");
  }

  it("returns 0 for a consistent build", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeValidSite();
    expect(runInternalLinkCheckCli(outDir, tomlPath)).toBe(0);
  });

  it("returns 1 and lists each broken source in HTML, manifest and llms.txt", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    writeValidSite();
    writeOutput("index.html", `<a href="/missing">m</a>`);
    writeOutput(
      "images/site.webmanifest",
      JSON.stringify({ icons: [{ src: "/images/nope.png" }] }),
    );
    writeOutput("llms.txt", "- [Gone](https://neonpixels.dev/gone): x");
    expect(runInternalLinkCheckCli(outDir, tomlPath)).toBe(1);
    const output = errors.mock.calls.flat().join("\n");
    expect(output).toContain("index.html: /missing");
    expect(output).toContain("images/site.webmanifest: /images/nope.png");
    expect(output).toContain("llms.txt: https://neonpixels.dev/gone");
  });

  it("throws when llms.txt or the manifest is missing", () => {
    writeOutput("index.html");
    expect(() => runInternalLinkCheckCli(outDir, tomlPath)).toThrow(
      /Expected images\/site\.webmanifest/,
    );
    writeOutput("images/site.webmanifest", "{}");
    expect(() => runInternalLinkCheckCli(outDir, tomlPath)).toThrow(
      /Expected llms\.txt/,
    );
  });

  it("throws when netlify.toml is missing", () => {
    writeValidSite();
    expect(() =>
      runInternalLinkCheckCli(outDir, join(workDir, "missing.toml")),
    ).toThrow(/netlify\.toml not found/);
  });

  it("names the manifest when its JSON is invalid", () => {
    writeValidSite();
    writeOutput("images/site.webmanifest", "{nope");
    expect(() => runInternalLinkCheckCli(outDir, tomlPath)).toThrow(
      /Invalid JSON in images\/site\.webmanifest/,
    );
  });

  it("throws when there is no build output", () => {
    expect(() =>
      runInternalLinkCheckCli(join(workDir, "nope"), tomlPath),
    ).toThrow(/npm run build/);
  });
});
