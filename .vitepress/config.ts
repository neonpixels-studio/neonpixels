import { defineConfig, type Plugin } from "vitepress";
import tailwindcss from "@tailwindcss/vite";

const SITE_URL = "https://neonpixels.io";
const DESCRIPTION =
  "A very small studio and one very caffeinated agent, shipping the tools we kept wishing existed. Grimicorn, Wanderist, Basin and Markpost — every project started as a personal annoyance and escaped into production.";
const OG_TITLE = "Neon Pixels — We build the missing apps";
const OG_IMAGE = `${SITE_URL}/images/social-card.png`;
const OG_IMAGE_ALT =
  "Neon Pixels wordmark on a dark grid, with the pixel logo mark and the four project names — grimicorn.dev, wanderist.io, basin.fm, markpost.io — glowing in lime, cyan, amber and pink.";

const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Neon Pixels",
  description: DESCRIPTION,
  url: SITE_URL,
  logo: `${SITE_URL}/images/neon-pixels-mark.svg`,
  image: OG_IMAGE,
});

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
    // Fonts
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "",
      },
    ],
    [
      "link",
      {
        href: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap",
        rel: "stylesheet",
      },
    ],
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
    // while VitePress bundles its own Vite 5. The Plugin shapes are compatible
    // at runtime but nominally distinct across the major gap, so cast to
    // VitePress's re-exported (Vite 5) Plugin type at the seam.
    plugins: [tailwindcss() as unknown as Plugin[]],
  },
});
