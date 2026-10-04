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

// Per-page head tags that must differ from page to page. Declared here, not in
// the global head, so a page can never inherit the homepage's canonical or
// social title (issue #174).
export function buildPageSeoHead(input: PageSeoInput): HeadConfig[] {
  const url = buildPageUrl(input);
  return [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { property: "og:title", content: input.title }],
    ["meta", { name: "twitter:title", content: input.title }],
  ];
}
