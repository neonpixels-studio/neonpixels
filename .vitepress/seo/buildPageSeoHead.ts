import type { HeadConfig } from "vitepress";

const MARKDOWN_EXTENSION = /\.md$/;
const INDEX_FILE_NAME = "index";
const HTML_EXTENSION = ".html";
const PATH_SEPARATOR = "/";
const TRAILING_SLASH = /\/$/;

export interface PageSeoInput {
  siteUrl: string;
  relativePath: string;
  cleanUrls: boolean;
  title: string;
  description?: string;
  fallbackDescription: string;
}

function directoryUrl(siteUrl: string, segments: string[]) {
  if (!segments.length) {
    return siteUrl;
  }
  return `${siteUrl}${PATH_SEPARATOR}${segments.join(PATH_SEPARATOR)}${PATH_SEPARATOR}`;
}

// Mirrors how VitePress maps a source file to its public URL: the homepage is
// the bare domain, `dir/index.md` is `/dir/`, and any other page gets a
// `.html` suffix unless cleanUrls is on.
export function buildPageUrl({
  siteUrl: rawSiteUrl,
  relativePath,
  cleanUrls,
}: Pick<PageSeoInput, "siteUrl" | "relativePath" | "cleanUrls">) {
  const siteUrl = rawSiteUrl.replace(TRAILING_SLASH, "");
  const segments = relativePath
    .replace(MARKDOWN_EXTENSION, "")
    .split(PATH_SEPARATOR);
  const isIndex = segments[segments.length - 1] === INDEX_FILE_NAME;
  if (isIndex) {
    segments.pop();
    return directoryUrl(siteUrl, segments);
  }
  const suffix = cleanUrls ? "" : HTML_EXTENSION;
  return `${siteUrl}${PATH_SEPARATOR}${segments.join(PATH_SEPARATOR)}${suffix}`;
}

// A page without its own frontmatter description (VitePress reports it as an
// empty string) falls back to the site-wide one.
function resolveDescription({
  description,
  fallbackDescription,
}: Pick<PageSeoInput, "description" | "fallbackDescription">) {
  return description?.trim() || fallbackDescription;
}

// Per-page head tags that must differ from page to page. Declared here, not in
// the global head, so a page can never inherit the homepage's canonical, social
// title (issue #174) or social description (issue #189).
export function buildPageSeoHead(input: PageSeoInput): HeadConfig[] {
  const url = buildPageUrl(input);
  const description = resolveDescription(input);
  return [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { property: "og:title", content: input.title }],
    ["meta", { name: "twitter:title", content: input.title }],
    ["meta", { property: "og:description", content: description }],
    ["meta", { name: "twitter:description", content: description }],
  ];
}
