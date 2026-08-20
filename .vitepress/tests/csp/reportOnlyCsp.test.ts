import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  buildReportOnlyCsp,
  collectInlineScriptHashes,
  extractInlineScriptBodies,
  sha256Source,
} from "../../csp/reportOnlyCsp";

const ENFORCING_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'";

function expectedSha256Source(scriptBody: string) {
  const digest = createHash("sha256")
    .update(scriptBody, "utf8")
    .digest("base64");
  return `'sha256-${digest}'`;
}

describe("extractInlineScriptBodies", () => {
  it("returns the body of an executable inline script", () => {
    const html = `<script>window.__VP__=1;</script>`;
    expect(extractInlineScriptBodies(html)).toEqual(["window.__VP__=1;"]);
  });

  it("includes module scripts but skips scripts with a src", () => {
    const html =
      `<script type="module" src="/assets/app.js"></script>` +
      `<script type="module">import "./x";</script>`;
    expect(extractInlineScriptBodies(html)).toEqual([`import "./x";`]);
  });

  it("skips non-executable data blocks like application/ld+json", () => {
    const html = `<script type="application/ld+json">{"@type":"Organization"}</script>`;
    expect(extractInlineScriptBodies(html)).toEqual([]);
  });

  it("skips the other inert data types (json, template, html)", () => {
    const html =
      `<script type="application/json">{}</script>` +
      `<script type="text/template"><div></div></script>` +
      `<script type="text/html"><span></span></script>`;
    expect(extractInlineScriptBodies(html)).toEqual([]);
  });

  it("skips an empty or whitespace-only inline script", () => {
    const html = `<script></script><script>  </script>`;
    expect(extractInlineScriptBodies(html)).toEqual([]);
  });

  it("returns each executable inline script in document order", () => {
    const html =
      `<script id="a">a()</script>` +
      `<script type="application/ld+json">{}</script>` +
      `<script id="b">b()</script>`;
    expect(extractInlineScriptBodies(html)).toEqual(["a()", "b()"]);
  });

  it("does not treat data-src / data-type as src or type attributes", () => {
    const html =
      `<script data-src="/ignored.js">withDataSrc()</script>` +
      `<script data-type="boot">withDataType()</script>`;
    expect(extractInlineScriptBodies(html)).toEqual([
      "withDataSrc()",
      "withDataType()",
    ]);
  });

  it("hashes a type carrying a MIME parameter and an importmap", () => {
    const html =
      `<script type="text/javascript;charset=utf-8">withCharset()</script>` +
      `<script type="importmap">{"imports":{}}</script>`;
    expect(extractInlineScriptBodies(html)).toEqual([
      "withCharset()",
      `{"imports":{}}`,
    ]);
  });

  it("keeps the body intact when an attribute value contains a '>'", () => {
    const html = `<script data-label="a>b">boot()</script>`;
    expect(extractInlineScriptBodies(html)).toEqual(["boot()"]);
  });

  it("does not treat a src=/type= substring inside another value as the attribute", () => {
    const html =
      `<script data-config="mode=a src=b">withSrcInValue()</script>` +
      `<script data-note="type=application/ld+json">withTypeInValue()</script>`;
    expect(extractInlineScriptBodies(html)).toEqual([
      "withSrcInValue()",
      "withTypeInValue()",
    ]);
  });

  it("handles a whitespace-tolerant </script > end tag without merging scripts", () => {
    const html = `<script>a()</script ><script>b()</script>`;
    expect(extractInlineScriptBodies(html)).toEqual(["a()", "b()"]);
  });
});

describe("sha256Source", () => {
  it("wraps the base64 sha256 of the UTF-8 body as a CSP hash-source", () => {
    const body = "document.title='héllo';";
    expect(sha256Source(body)).toBe(expectedSha256Source(body));
    expect(sha256Source(body)).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });
});

describe("collectInlineScriptHashes", () => {
  it("dedupes a shared bootstrap script across documents and sorts", () => {
    const shared = `<script id="boot">boot()</script>`;
    const pageOne = `${shared}<script id="one">one()</script>`;
    const pageTwo = `${shared}<script id="two">two()</script>`;
    const hashes = collectInlineScriptHashes([pageOne, pageTwo]);
    expect(hashes).toEqual(
      [
        expectedSha256Source("boot()"),
        expectedSha256Source("one()"),
        expectedSha256Source("two()"),
      ].sort(),
    );
  });

  it("returns an empty array when there are no executable inline scripts", () => {
    const html = `<script src="/a.js"></script><script type="application/ld+json">{}</script>`;
    expect(collectInlineScriptHashes([html])).toEqual([]);
  });
});

describe("buildReportOnlyCsp", () => {
  const hashes = ["'sha256-AAA='", "'sha256-BBB='"];

  it("swaps script-src 'unsafe-inline' for the inline-script hashes", () => {
    const reportOnly = buildReportOnlyCsp(ENFORCING_CSP, hashes);
    expect(reportOnly).toContain(
      `script-src 'self' 'sha256-AAA=' 'sha256-BBB='`,
    );
    expect(reportOnly).not.toContain(`script-src 'self' 'unsafe-inline'`);
  });

  it("leaves every other directive untouched, including style-src 'unsafe-inline'", () => {
    const reportOnly = buildReportOnlyCsp(ENFORCING_CSP, hashes);
    expect(reportOnly).toContain(`style-src 'self' 'unsafe-inline'`);
    expect(reportOnly).toContain(`default-src 'self'`);
    expect(reportOnly).toContain(`object-src 'none'`);
    expect(reportOnly).toContain(`connect-src 'self'`);
  });

  it("appends a script-src that inherits default-src when none is declared", () => {
    const reportOnly = buildReportOnlyCsp("default-src 'self'", hashes);
    expect(reportOnly).toBe(
      `default-src 'self'; script-src 'self' 'sha256-AAA=' 'sha256-BBB='`,
    );
  });

  it("inherits a restrictive default-src, dropping 'none' beside the hashes", () => {
    const reportOnly = buildReportOnlyCsp("default-src 'none'", hashes);
    expect(reportOnly).toBe(
      `default-src 'none'; script-src 'sha256-AAA=' 'sha256-BBB='`,
    );
  });

  it("drops 'none' from an explicit script-src when adding hashes", () => {
    const reportOnly = buildReportOnlyCsp(
      "default-src 'self'; script-src 'none'",
      hashes,
    );
    expect(reportOnly).toBe(
      `default-src 'self'; script-src 'sha256-AAA=' 'sha256-BBB='`,
    );
  });

  it("falls back to 'self' when neither script-src nor default-src exists", () => {
    const reportOnly = buildReportOnlyCsp("object-src 'none'", hashes);
    expect(reportOnly).toBe(
      `object-src 'none'; script-src 'self' 'sha256-AAA=' 'sha256-BBB='`,
    );
  });
});
