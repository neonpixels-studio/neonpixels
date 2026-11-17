import { BRAND_ACCENTS } from "../brand";

// One record per project drives everything that repeats across the page: the
// hero pills, the footer links, and the project sections. Adding or
// editing a project is a data change here, never a markup copy. Each project's
// accent `color` references the centralized BRAND_ACCENTS so it can't drift from
// the wordmark gradient and CSS tokens built on the same hexes.

// "fill" projects (a shipped one) get a solid badge + CTA; "outline" projects
// (still in progress) get a bordered badge + CTA.
export type ProjectVariant = "fill" | "outline";

export type ProjectAccent = {
  // Full Tailwind class strings, not tokens, so the JIT scanner still sees them.
  text: string;
  bg: string;
  border: string;
};

export type ProjectAurora = {
  // Which ambient-blob animation and where it sits behind the section.
  animation: string;
  position: string;
  size: string;
  duration: string;
  alpha: number;
};

export type ProjectSectionStyle = {
  background: string;
  topLine: string;
  aurora: ProjectAurora;
};

export type Project = {
  id: string;
  name: string;
  tld: string;
  url: string;
  color: string;
  pillBg: string;
  pillBgHover: string;
  pillBorder: string;
  order: string;
  category: string;
  status: string;
  variant: ProjectVariant;
  flickerTld: boolean;
  description: string;
  accent: ProjectAccent;
  section: ProjectSectionStyle;
};

export const PROJECTS: Project[] = [
  {
    id: "grimicorn",
    name: "grimicorn",
    tld: ".dev",
    url: "https://grimicorn.dev",
    color: BRAND_ACCENTS.lime,
    pillBg: "#12180a",
    pillBgHover: "#1a2410",
    pillBorder: "#2b3a14",
    order: "01",
    category: "agent workflow",
    status: "LIVE",
    variant: "fill",
    flickerTld: true,
    description:
      "The chaotic coding sidekick behind everything else on this page. An automated agent workflow that builds, breaks, and ships the other Neon Pixels projects while I'm asleep.",
    accent: { text: "text-lime", bg: "bg-lime", border: "border-lime" },
    section: {
      background: "linear-gradient(100deg, #0d1206 0%, #08080a 58%)",
      topLine: "linear-gradient(90deg, #b8ff2e, transparent 65%)",
      aurora: {
        animation: "animate-aurora",
        position: "top-[-30%] left-[-6%]",
        size: "h-[520px] w-[520px]",
        duration: "28s",
        alpha: 0.18,
      },
    },
  },
  {
    id: "basin",
    name: "basin",
    tld: ".fm",
    url: "https://basin.fm",
    color: BRAND_ACCENTS.amber,
    pillBg: "#1a1305",
    pillBgHover: "#241a07",
    pillBorder: "#3d2f0c",
    order: "02",
    category: "syndication",
    status: "IN PROGRESS",
    variant: "outline",
    flickerTld: false,
    description:
      "Everything you consume, in one stream. RSS, podcasts, YouTube and Bluesky today — Twitter, Instagram and whatever else annoys me next.",
    accent: { text: "text-amber", bg: "bg-amber", border: "border-amber" },
    section: {
      background: "linear-gradient(260deg, #170f02 0%, #08080a 58%)",
      topLine: "linear-gradient(270deg, #ffc21f, transparent 65%)",
      aurora: {
        animation: "animate-aurora-reverse",
        position: "bottom-[-34%] right-[2%]",
        size: "h-[520px] w-[520px]",
        duration: "30s",
        alpha: 0.15,
      },
    },
  },
  {
    id: "markpost",
    name: "markpost",
    tld: ".io",
    url: "https://markpost.io",
    color: BRAND_ACCENTS.pink,
    pillBg: "#1b0713",
    pillBgHover: "#250a1a",
    pillBorder: "#3d1029",
    order: "03",
    category: "capture",
    status: "IN PROGRESS",
    variant: "outline",
    flickerTld: false,
    description:
      "Send a webhook or an email, get a Markdown file on your own filesystem. Built for Obsidian, works with anything that reads Markdown.",
    accent: { text: "text-pink", bg: "bg-pink", border: "border-pink" },
    section: {
      background: "linear-gradient(100deg, #180618 0%, #08080a 58%)",
      topLine: "linear-gradient(90deg, #ff2ea6, transparent 65%)",
      aurora: {
        animation: "animate-aurora",
        position: "top-[-20%] left-0",
        size: "h-[540px] w-[540px]",
        duration: "36s",
        alpha: 0.16,
      },
    },
  },
];
