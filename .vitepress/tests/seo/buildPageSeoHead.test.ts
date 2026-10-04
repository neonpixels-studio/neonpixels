import { describe, it, expect } from "vitest";

import { buildPageSeoHead, buildPageUrl } from "../../seo/buildPageSeoHead";

const SITE_URL = "https://neonpixels.dev";

describe("buildPageUrl", () => {
  it.each([
    ["index.md", false, SITE_URL],
    ["index.md", true, SITE_URL],
    ["privacy.md", false, `${SITE_URL}/privacy.html`],
    ["privacy.md", true, `${SITE_URL}/privacy`],
    ["docs/index.md", false, `${SITE_URL}/docs/`],
    ["docs/index.md", true, `${SITE_URL}/docs/`],
    ["docs/setup.md", false, `${SITE_URL}/docs/setup.html`],
    ["docs/setup.md", true, `${SITE_URL}/docs/setup`],
  ])("maps %s (cleanUrls=%s) to %s", (relativePath, cleanUrls, expected) => {
    expect(buildPageUrl({ siteUrl: SITE_URL, relativePath, cleanUrls })).toBe(
      expected,
    );
  });
});

describe("buildPageUrl with a trailing-slash siteUrl", () => {
  it("does not double the slash", () => {
    expect(
      buildPageUrl({
        siteUrl: `${SITE_URL}/`,
        relativePath: "privacy.md",
        cleanUrls: false,
      }),
    ).toBe(`${SITE_URL}/privacy.html`);
  });
});

describe("buildPageSeoHead", () => {
  const privacy = buildPageSeoHead({
    siteUrl: SITE_URL,
    relativePath: "privacy.md",
    cleanUrls: false,
    title: "Privacy Policy",
  });

  it("emits a canonical that is not the homepage", () => {
    expect(privacy).toContainEqual([
      "link",
      { rel: "canonical", href: `${SITE_URL}/privacy.html` },
    ]);
  });

  it("emits og:url, og:title and twitter:title for the page", () => {
    expect(privacy).toContainEqual([
      "meta",
      { property: "og:url", content: `${SITE_URL}/privacy.html` },
    ]);
    expect(privacy).toContainEqual([
      "meta",
      { property: "og:title", content: "Privacy Policy" },
    ]);
    expect(privacy).toContainEqual([
      "meta",
      { name: "twitter:title", content: "Privacy Policy" },
    ]);
  });
});
