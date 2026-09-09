import { defineConfig, type Plugin } from "vitepress";
import tailwindcss from "@tailwindcss/vite";

import { writeReportOnlyHeaders } from "./csp/writeReportOnlyHeaders";
import { getNoindexHeaderLines } from "./robots/getNoindexHeaderLines";
import { PROJECTS, type Project } from "./theme/data/projects";

const SITE_URL = "https://neonpixels.io";
const DESCRIPTION =
  "A very small studio and one very caffeinated agent, shipping the tools we kept wishing existed. Grimicorn, Wanderist, Basin and Markpost — every project started as a personal annoyance and escaped into production.";
const OG_TITLE = "Neon Pixels — We build the missing apps";
const OG_IMAGE = `${SITE_URL}/images/social-card.png`;
const OG_IMAGE_ALT =
  "Neon Pixels wordmark on a dark grid, with the pixel logo mark and the four project names — grimicorn.dev, wanderist.io, basin.fm, markpost.io — glowing in lime, cyan, amber and pink.";

// The org exists to promote the four projects, but PROJECTS already owns their
// canonical name/url/description — deriving each project's ld+json node from
// it means the project graph can't drift from what's rendered on the page
// (issue #83).
//
// Each project is its own WebSite node, linked back to the org via
// `publisher`, rather than folded into the Organization node as `sameAs` or
// `hasPart`: schema.org defines `sameAs` as an identity assertion ("this page
// and that page describe the same thing"), so listing the four project
// domains there would tell crawlers neonpixels.io *is* grimicorn.dev,
// wanderist.io, basin.fm and markpost.io — the opposite of "the org publishes
// these products". `hasPart` isn't defined on Organization at all (only on
// CreativeWork/Place), so it validates as an unrecognized property there. A
// `@graph` of sibling nodes tied together by `publisher` is the shape that
// both validates and expresses the intended org -> product relationship.
//
// WebSite over SoftwareApplication deliberately: SoftwareApplication is a
// rich-result type Google grades on `offers`/`aggregateRating` (neither of
// which exists for these projects, three of which are still `"IN PROGRESS"`
// per PROJECTS), so claiming it would trade "not present" for "invalid" in
// Search Console. WebSite carries no such required-field contract.
const ORGANIZATION_ID = `${SITE_URL}#organization`;

// Only the fields the ld+json node actually reads — narrower than the full
// Project type so a test fixture doesn't have to fabricate every pill color
// and animation timing just to exercise this function.
type ProjectJsonLdSource = Pick<
  Project,
  "name" | "tld" | "url" | "description"
>;

function projectLabel(project: ProjectJsonLdSource) {
  return `${project.name}${project.tld}`;
}

function buildProjectNode(project: ProjectJsonLdSource) {
  return {
    "@type": "WebSite",
    "@id": `${project.url}#website`,
    name: projectLabel(project),
    url: project.url,
    description: project.description,
    publisher: { "@id": ORGANIZATION_ID },
  };
}

// Exported (rather than inlined below) so a test can feed it a fixture
// description containing "</script>" and assert on the serialized string —
// asserting only on the parsed object would hide a regression that stops
// escaping "<", since JSON.parse silently undoes the escape either way.
//
// `<` isn't escaped by JSON.stringify, and this payload interpolates project
// descriptions from a data module edited independently of this file — a
// description containing "</script>" would otherwise close the tag early.
// "<" is valid JSON and parses back to "<", so nothing downstream changes.
export function buildOrganizationJsonLd(projects: ProjectJsonLdSource[]) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: "Neon Pixels",
        description: DESCRIPTION,
        url: SITE_URL,
        logo: `${SITE_URL}/images/neon-pixels-mark.svg`,
        image: OG_IMAGE,
      },
      ...projects.map(buildProjectNode),
    ],
  }).replace(/</g, "\\u003c");
}

const JSON_LD = buildOrganizationJsonLd(PROJECTS);

export default defineConfig({
  title: "Neon Pixels",
  description: DESCRIPTION,
  lang: "en-US",
  // Repo docs, scratch files and the original design export are not site routes.
  srcExclude: ["README.md", "_claude-*.md", "export/**"],
  sitemap: {
    hostname: SITE_URL,
  },
  head: [
    // Fonts are self-hosted — see .vitepress/theme/index.ts
    // Canonical + theme color
    ["link", { rel: "canonical", href: SITE_URL }],
    ["meta", { name: "theme-color", content: "#08080a" }],
    // Open Graph
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { property: "og:url", content: SITE_URL }],
    ["meta", { property: "og:title", content: OG_TITLE }],
    ["meta", { property: "og:description", content: DESCRIPTION }],
    ["meta", { property: "og:image", content: OG_IMAGE }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: OG_IMAGE_ALT }],
    // Twitter Card
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: OG_TITLE }],
    ["meta", { name: "twitter:description", content: DESCRIPTION }],
    ["meta", { name: "twitter:image", content: OG_IMAGE }],
    ["meta", { name: "twitter:image:alt", content: OG_IMAGE_ALT }],
    // Structured data
    ["script", { type: "application/ld+json" }, JSON_LD],
    // Favicon
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        href: "/images/favicon-96x96.png?v=20260808",
        sizes: "96x96",
      },
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/images/favicon.svg?v=20260808",
      },
    ],
    ["link", { rel: "shortcut icon", href: "/images/favicon.ico?v=20260808" }],
    [
      "link",
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/images/apple-touch-icon.png?v=20260808",
      },
    ],
    ["meta", { name: "apple-mobile-web-app-title", content: "Neon Pixels" }],
    ["link", { rel: "manifest", href: "/images/site.webmanifest?v=20260808" }],
  ],
  vite: {
    // tailwindcss() is typed against the top-level Vite 8 (required by Vitest),
    // while VitePress bundles its own Vite 6 (pinned via the `overrides` block
    // in package.json to pull in a patched vite/esbuild). The Plugin shapes are
    // compatible at runtime but nominally distinct across the major gap, so
    // cast to VitePress's re-exported (Vite 6) Plugin type at the seam.
    plugins: [tailwindcss() as unknown as Plugin[]],
  },
  // Hash the inline bootstrap scripts VitePress emits and publish them in a
  // Content-Security-Policy-Report-Only header (Netlify `_headers`). Derived from
  // the real build output so the hashes can never drift silently. The enforcing
  // CSP in netlify.toml keeps 'unsafe-inline' until this Report-Only rollout
  // confirms no violations — see the @todo there.
  //
  // Also noindexes deploy-preview/branch-deploy builds (see .vitepress/robots)
  // since Netlify headers can't be scoped by context in netlify.toml itself;
  // the noindex line rides in the same `/*` block this hook already writes.
  async buildEnd(siteConfig) {
    // The skipped `undefined` is netlifyConfigPath, a test-only override seam
    // (see writeReportOnlyHeaders.test.ts) — production always wants its
    // default, so it has to be named here to reach extraGlobalHeaderLines.
    await writeReportOnlyHeaders(
      siteConfig.outDir,
      undefined,
      getNoindexHeaderLines(),
    );
  },
});
