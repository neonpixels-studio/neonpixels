import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReportOnlyHeaders } from "../../csp/writeReportOnlyHeaders";

const HEADERS_FILE = "_headers";
const REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";
const ENFORCING_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'";
const INLINE_SCRIPT = `<script id="boot">boot()</script>`;
const NETLIFY_WITH_CSP = `[[headers]]\n  for = "/*"\n  [headers.values]\n    Content-Security-Policy = "${ENFORCING_CSP}"\n`;

let workDir = "";
let outDir = "";
let netlifyConfigPath = "";

function writeOutFile(name: string, contents: string) {
  writeFileSync(join(outDir, name), contents);
}

function writeNetlifyConfig(contents: string) {
  writeFileSync(netlifyConfigPath, contents);
}

function readGeneratedHeaders() {
  return readFileSync(join(outDir, HEADERS_FILE), "utf8");
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "neonpixels-csp-writer-"));
  outDir = join(workDir, "dist");
  netlifyConfigPath = join(workDir, "netlify.toml");
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("writeReportOnlyHeaders", () => {
  it("writes a Report-Only header derived from the build's inline scripts", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await writeReportOnlyHeaders(outDir, netlifyConfigPath);

    const headers = readGeneratedHeaders();
    expect(headers).toContain(`${REPORT_ONLY_HEADER_NAME}:`);
    expect(headers).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(headers).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("wires the Report-Only policy to the collector and emits Reporting-Endpoints", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await writeReportOnlyHeaders(outDir, netlifyConfigPath);

    const headers = readGeneratedHeaders();
    expect(headers).toContain("report-uri /csp-report");
    expect(headers).toContain("report-to csp-endpoint");
    expect(headers).toContain(
      `Reporting-Endpoints: csp-endpoint="/csp-report"`,
    );
  });

  it("preserves a hand-written _headers file instead of clobbering it", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeOutFile(
      HEADERS_FILE,
      "/assets/*\n  Cache-Control: max-age=31536000\n",
    );
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await writeReportOnlyHeaders(outDir, netlifyConfigPath);

    const headers = readGeneratedHeaders();
    expect(headers).toContain("Cache-Control: max-age=31536000");
    expect(headers).toContain(`${REPORT_ONLY_HEADER_NAME}:`);
  });

  it("replaces its own previous block rather than stacking a second on rebuild", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await writeReportOnlyHeaders(outDir, netlifyConfigPath);
    await writeReportOnlyHeaders(outDir, netlifyConfigPath);

    const headers = readGeneratedHeaders();
    const occurrences = headers.split(REPORT_ONLY_HEADER_NAME).length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps a single Reporting-Endpoints line across rebuilds", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await writeReportOnlyHeaders(outDir, netlifyConfigPath);
    await writeReportOnlyHeaders(outDir, netlifyConfigPath);

    const headers = readGeneratedHeaders();
    expect(headers.split("Reporting-Endpoints:").length - 1).toBe(1);
  });

  it("throws when a hand-written file already declares a Report-Only header", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeOutFile(
      HEADERS_FILE,
      `/*\n  ${REPORT_ONLY_HEADER_NAME}: default-src 'self'\n`,
    );
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await expect(
      writeReportOnlyHeaders(outDir, netlifyConfigPath),
    ).rejects.toThrow(/two conflicting policies/);
  });

  it("throws when a hand-written file already declares a Reporting-Endpoints header", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeOutFile(
      HEADERS_FILE,
      `/*\n  Reporting-Endpoints: csp-endpoint="https://elsewhere.example"\n`,
    );
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await expect(
      writeReportOnlyHeaders(outDir, netlifyConfigPath),
    ).rejects.toThrow(/two conflicting policies/);
  });

  it("throws when the build output has no executable inline scripts", async () => {
    writeOutFile(
      "index.html",
      `<script src="/app.js"></script><script type="application/ld+json">{}</script>`,
    );
    writeNetlifyConfig(NETLIFY_WITH_CSP);

    await expect(
      writeReportOnlyHeaders(outDir, netlifyConfigPath),
    ).rejects.toThrow(/no executable inline scripts/);
  });

  it("throws when netlify.toml has no enforcing CSP", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(`[[headers]]\n  for = "/*"\n`);

    await expect(
      writeReportOnlyHeaders(outDir, netlifyConfigPath),
    ).rejects.toThrow(/could not read the enforcing/);
  });

  it("throws when netlify.toml declares more than one enforcing CSP", async () => {
    writeOutFile("index.html", INLINE_SCRIPT);
    writeNetlifyConfig(`${NETLIFY_WITH_CSP}${NETLIFY_WITH_CSP}`);

    await expect(
      writeReportOnlyHeaders(outDir, netlifyConfigPath),
    ).rejects.toThrow(/multiple Content-Security-Policy headers/);
  });
});
