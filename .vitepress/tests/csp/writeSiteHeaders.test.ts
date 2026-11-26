// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadersFileError } from "@neon-pixels/security/netlify";

import {
  appendToPolicyBlock,
  writeSiteHeaders,
} from "../../csp/writeSiteHeaders";
import { readGlobalHeaders } from "../../../e2e/support/enforcedCsp";
import { SENTRY_DSN, SENTRY_INGEST_ORIGIN } from "../../sentry-dsn";
import {
  SENTRY_SECURITY_REPORT_URL,
  securityReportEndpoint,
} from "../../csp/sitePolicy";

const PAGE_WITH_INLINE_SCRIPT_AND_STYLE =
  "<!doctype html><html><head><style>body{margin:0}</style></head><body><script>window.ready = true;</script></body></html>";
const PAGE_WITH_STYLE_ATTRIBUTE =
  '<!doctype html><html><body><p style="color: red">hello</p></body></html>';
const HAND_WRITTEN_HEADERS = "/assets/*\n  Cache-Control: public, immutable\n";
const NOINDEX_LINE = "X-Robots-Tag: noindex";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "np-site-headers-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function build({
  page = PAGE_WITH_INLINE_SCRIPT_AND_STYLE,
  environment = "production",
  extraHeaderLines = [] as string[],
} = {}) {
  await writeFile(join(outDir, "index.html"), page);
  await writeFile(join(outDir, "_headers"), HAND_WRITTEN_HEADERS);
  const result = await writeSiteHeaders(outDir, {
    environment,
    extraHeaderLines,
  });
  return { result, headersFile: await readFile(result.path, "utf8") };
}

describe("writeSiteHeaders", () => {
  it("keeps the hand-written rules and appends the enforced policy", async () => {
    const { headersFile } = await build();
    expect(headersFile.startsWith(HAND_WRITTEN_HEADERS)).toBe(true);
    expect(headersFile).toMatch(/^ {2}Content-Security-Policy: /m);
    expect(headersFile).not.toContain("Report-Only");
  });

  it("hashes the inline script and style and allows no 'unsafe-inline'", async () => {
    const { result, headersFile } = await build();
    expect(result.scriptHashes).toHaveLength(1);
    expect(result.styleHashes).toHaveLength(1);
    expect(headersFile).toContain(result.scriptHashes[0]);
    expect(headersFile).toContain(result.styleHashes[0]);
    expect(headersFile).not.toContain("unsafe-inline");
  });

  it("writes the security headers the package owns", async () => {
    const { headersFile } = await build();
    for (const name of [
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Strict-Transport-Security",
      "X-Frame-Options",
      "Reporting-Endpoints",
    ]) {
      expect(headersFile).toMatch(new RegExp(`^ {2}${name}: `, "m"));
    }
  });

  it.each(["production", "preview"])(
    "reports %s violations to Sentry tagged with that environment",
    async (environment) => {
      const { headersFile } = await build({ environment });
      const endpoint = `${SENTRY_SECURITY_REPORT_URL}&sentry_environment=${environment}`;
      expect(headersFile).toContain(`report-uri ${endpoint}`);
      expect(headersFile).toContain(`csp-endpoint="${endpoint}"`);
    },
  );

  it("puts the extra header lines in the same /* block as the policy", async () => {
    const { headersFile } = await build({ extraHeaderLines: [NOINDEX_LINE] });
    const blocks = headersFile
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith(" "));
    expect(blocks).toEqual(["/assets/*", "/*"]);
    expect(headersFile.trimEnd().endsWith(`  ${NOINDEX_LINE}`)).toBe(true);
  });

  it("writes the extra line as its own header with its own value", async () => {
    const { headersFile } = await build({ extraHeaderLines: [NOINDEX_LINE] });
    const entries = readGlobalHeaders(headersFile);
    expect(entries["X-Robots-Tag"]).toBe("noindex");
    expect(entries["Reporting-Endpoints"]).toMatch(
      /^csp-endpoint="https:\/\/.+"$/,
    );
  });

  it("sets no header twice", async () => {
    const { headersFile } = await build({ extraHeaderLines: [NOINDEX_LINE] });
    // readGlobalHeaders throws when a header is set twice for /*.
    expect(() => readGlobalHeaders(headersFile)).not.toThrow();
  });

  it("refuses to write into a _headers file that already holds the policy", async () => {
    await build();
    const failure = await writeSiteHeaders(outDir, {
      environment: "production",
      extraHeaderLines: [],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HeadersFileError);
    expect((failure as HeadersFileError).code).toBe("header-already-present");
  });

  it("fails the build with the package's error for a page it cannot hash", async () => {
    const failure = await build({ page: PAGE_WITH_STYLE_ATTRIBUTE }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HeadersFileError);
    expect((failure as HeadersFileError).code).toBe("unhashable-inline");
    expect((failure as HeadersFileError).files).toEqual(["index.html"]);
    expect((failure as HeadersFileError).message).toContain("index.html");
  });

  it("does not write a policy when the build fails", async () => {
    await build({ page: PAGE_WITH_STYLE_ATTRIBUTE }).catch(() => undefined);
    expect(await readFile(join(outDir, "_headers"), "utf8")).toBe(
      HAND_WRITTEN_HEADERS,
    );
  });
});

describe("writeSiteHeaders extra header lines", () => {
  it.each([
    ["an embedded newline", "X-A: b\n/other\n  X-C: d"],
    ["no name", ": value"],
    ["an empty value", "X-Robots-Tag: "],
  ])("refuses a line with %s before writing anything", async (_label, line) => {
    await expect(build({ extraHeaderLines: [line] })).rejects.toThrow(
      /malformed header line/,
    );
    expect(await readFile(join(outDir, "_headers"), "utf8")).toBe(
      HAND_WRITTEN_HEADERS,
    );
  });

  it("refuses a line that repeats a header the policy block already sets", async () => {
    await expect(
      build({ extraHeaderLines: ["x-frame-options: SAMEORIGIN"] }),
    ).rejects.toThrow(/x-frame-options twice/);
  });

  it("refuses the same extra header twice", async () => {
    await expect(
      build({ extraHeaderLines: ["X-A: 1", "X-A: 2"] }),
    ).rejects.toThrow(/x-a twice/);
  });
});

describe("securityReportEndpoint", () => {
  it("appends the Sentry environment to the one endpoint constant", () => {
    expect(securityReportEndpoint("preview")).toBe(
      `${SENTRY_SECURITY_REPORT_URL}&sentry_environment=preview`,
    );
  });

  it("points at the same Sentry project as the browser DSN, over https", () => {
    const url = new URL(SENTRY_SECURITY_REPORT_URL);
    const dsn = new URL(SENTRY_DSN);
    expect(url.protocol).toBe("https:");
    expect(url.origin).toBe(SENTRY_INGEST_ORIGIN);
    expect(url.pathname).toBe(`/api${dsn.pathname}/security/`);
    expect(url.searchParams.get("sentry_key")).toBe(dsn.username);
  });
});

describe("appendToPolicyBlock", () => {
  it("does nothing without lines", async () => {
    await appendToPolicyBlock(outDir, []);
    await expect(readFile(join(outDir, "_headers"), "utf8")).rejects.toThrow();
  });

  it("starts the new line on its own line when the file lacks a final newline", async () => {
    await writeFile(join(outDir, "_headers"), "/*\n  X-A: 1");
    await appendToPolicyBlock(outDir, [NOINDEX_LINE]);
    expect(await readFile(join(outDir, "_headers"), "utf8")).toBe(
      `/*\n  X-A: 1\n  ${NOINDEX_LINE}\n`,
    );
  });

  it("skips comment lines when finding the last block", async () => {
    await writeFile(
      join(outDir, "_headers"),
      "/*\n  X-A: 1\n# trailing note\n",
    );
    await appendToPolicyBlock(outDir, [NOINDEX_LINE]);
    expect(await readFile(join(outDir, "_headers"), "utf8")).toContain(
      `  ${NOINDEX_LINE}\n`,
    );
  });

  it("refuses to extend a block that is not the /* block", async () => {
    await writeFile(join(outDir, "_headers"), HAND_WRITTEN_HEADERS);
    await expect(appendToPolicyBlock(outDir, [NOINDEX_LINE])).rejects.toThrow(
      /expected the last block to be "\/\*"/,
    );
  });
});
