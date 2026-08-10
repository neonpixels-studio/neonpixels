<script setup lang="ts">
import { BRAND_ACCENTS, WORDMARK_GRADIENT, withAlpha } from "../brand";

// Each project drives the hero pills, the section accents and the footer links,
// so its accent color and dark pill tints live in one place.
const PROJECTS = [
  {
    id: "grimicorn",
    name: "grimicorn",
    tld: ".dev",
    url: "https://grimicorn.dev",
    color: BRAND_ACCENTS.lime,
    pillBg: "#12180a",
    pillBgHover: "#1a2410",
    pillBorder: "#2b3a14",
  },
  {
    id: "wanderist",
    name: "wanderist",
    tld: ".io",
    url: "https://wanderist.io",
    color: BRAND_ACCENTS.cyan,
    pillBg: "#08161b",
    pillBgHover: "#0c2028",
    pillBorder: "#123340",
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
  },
];

// Trip-log heatmap for the Wanderist card: each cell is one of four brightness
// states so the grid reads as visited / partly / faint / empty. The lit states
// are the cyan accent at descending alpha; the alpha suffixes (88/55 hex) fade
// it toward the empty tint.
const TRIP_CELL_COLORS = {
  on: BRAND_ACCENTS.cyan,
  mid: withAlpha(BRAND_ACCENTS.cyan, "88"),
  low: withAlpha(BRAND_ACCENTS.cyan, "55"),
  off: "#0e2831",
};

const TRIP_CELLS =
  "on off off mid off on off off low off on off off mid off off off low on off off off mid off off on off off low off on off mid off off on off low off on off off mid off off off on off".split(
    " ",
  ) as (keyof typeof TRIP_CELL_COLORS)[];

// Basin aggregates a mixed feed; opacity of the leading dot fades with recency
// via descending alpha suffixes on the amber accent (88/55/33 hex). Only the
// freshest item glows — `glow` states that intent on the data rather than
// inferring it from the dot's color.
const BASIN_FEED = [
  {
    title: "Syntax — 900: The One About Agents",
    kind: "podcast",
    dot: BRAND_ACCENTS.amber,
    glow: true,
    titleColor: "#e8e8ea",
  },
  {
    title: "CSS-Tricks — Anchor positioning, finally",
    kind: "rss",
    dot: withAlpha(BRAND_ACCENTS.amber, "88"),
    glow: false,
    titleColor: "#c4c4cd",
  },
  {
    title: "@dan.bsky.social — shipped something at 3am",
    kind: "bluesky",
    dot: withAlpha(BRAND_ACCENTS.amber, "55"),
    glow: false,
    titleColor: "#c4c4cd",
  },
  {
    title: "Fireship — 100 seconds of something new",
    kind: "youtube",
    dot: withAlpha(BRAND_ACCENTS.amber, "33"),
    glow: false,
    titleColor: "#c4c4cd",
  },
];

const GRIMICORN_TERMINAL = [
  { text: "[03:14] merged a PR you haven't read" },
  { text: "[03:16] shipped wanderist map tiles" },
  { text: "[03:19] broke staging. on purpose." },
];
</script>

<template>
  <div class="bg-bg text-fg relative font-mono">
    <!-- drifting grid backdrop -->
    <div
      class="animate-drift pointer-events-none fixed inset-0 z-0"
      style="
        background-image:
          linear-gradient(#ffffff08 1px, transparent 1px),
          linear-gradient(90deg, #ffffff08 1px, transparent 1px);
        background-size: 80px 80px;
      "
    />

    <!-- header -->
    <header
      class="border-border sticky top-0 z-30 flex items-center justify-between gap-6 border-b px-10 py-[22px] backdrop-blur-md"
      style="background: #08080ae6"
    >
      <a href="#top" class="flex items-center gap-[11px]">
        <svg
          width="20"
          height="20"
          viewBox="0 0 34 34"
          class="block flex-none"
          aria-hidden="true"
        >
          <rect x="0" y="22" width="10" height="10" fill="#22e0ff" />
          <rect x="12" y="11" width="10" height="10" fill="#b8ff2e" />
          <rect x="24" y="0" width="10" height="10" fill="#ff2ea6" />
        </svg>
        <span
          class="font-display text-[15px] font-black tracking-[-0.01em] text-[#f2f2f4]"
        >
          NEON<span
            class="animate-sweep bg-clip-text text-transparent"
            :style="{
              backgroundImage: WORDMARK_GRADIENT,
              '--np-sweep-dur': '7s',
            }"
            >PIXELS</span
          >
        </span>
      </a>
      <nav class="text-fg-subtle flex items-center gap-[26px] text-[12.5px]">
        <a href="#projects" class="nav-link text-fg-subtle">projects</a>
        <a href="#about" class="nav-link text-fg-subtle">about</a>
        <span class="text-lime flex items-center gap-[7px]">
          <span
            class="bg-lime animate-pulse-dot h-[7px] w-[7px] rounded-full"
            style="box-shadow: 0 0 8px #b8ff2e"
          />4 projects
        </span>
      </nav>
    </header>

    <!-- hero -->
    <section id="top" class="relative z-[2] overflow-hidden px-10 pt-28 pb-24">
      <div
        class="animate-aurora pointer-events-none absolute top-[-30%] left-[8%] h-[640px] w-[640px] rounded-full blur-[38px]"
        style="
          background: radial-gradient(
            circle,
            rgba(184, 255, 46, 0.16),
            transparent 62%
          );
        "
      />
      <div
        class="animate-aurora-reverse pointer-events-none absolute top-[-14%] right-[2%] h-[560px] w-[560px] rounded-full blur-[38px]"
        style="
          --np-aurora-dur: 32s;
          background: radial-gradient(
            circle,
            rgba(255, 46, 166, 0.15),
            transparent 62%
          );
        "
      />
      <div
        class="animate-aurora pointer-events-none absolute bottom-[-24%] left-[34%] h-[520px] w-[520px] rounded-full blur-[40px]"
        style="
          --np-aurora-dur: 38s;
          background: radial-gradient(
            circle,
            rgba(34, 224, 255, 0.13),
            transparent 62%
          );
        "
      />

      <div class="relative mx-auto flex max-w-[1180px] flex-col gap-[34px]">
        <div
          class="flex items-center gap-[14px] text-[11.5px] tracking-[0.24em] text-[#7a7a85] uppercase"
        >
          <span
            class="bg-lime h-px w-[26px]"
            style="box-shadow: 0 0 6px #b8ff2e"
          />
          a very small studio · a lot of side projects
        </div>

        <h1
          class="font-display m-0 font-black tracking-[-0.035em] text-[#f4f4f6]"
          style="
            font-size: clamp(56px, 9vw, 132px);
            line-height: 0.86;
            text-wrap: balance;
          "
        >
          WE BUILD THE<br />
          <span
            class="animate-sweep bg-clip-text text-transparent"
            :style="{ backgroundImage: WORDMARK_GRADIENT }"
            >MISSING APPS</span
          >
        </h1>

        <p
          class="m-0 max-w-[640px] text-[15.5px] leading-[1.75] text-[#a8a8b3]"
          style="text-wrap: pretty"
        >
          Neon Pixels is one human and one very caffeinated agent, shipping the
          tools we kept wishing existed. Every project here started as a
          personal annoyance and escaped into production.
          <span class="text-fg">You're welcome to use them.</span>
        </p>

        <div class="flex flex-wrap gap-[10px]">
          <a
            v-for="project in PROJECTS"
            :key="project.id"
            :href="`#${project.id}`"
            class="pill flex items-center gap-[9px] border px-[15px] py-[9px] text-[12.5px]"
            :style="{
              color: project.color,
              borderColor: project.pillBorder,
              background: project.pillBg,
              '--pill-bg-hover': project.pillBgHover,
              '--accent': project.color,
            }"
          >
            <span
              class="h-[6px] w-[6px]"
              :style="{
                background: project.color,
                boxShadow: `0 0 7px ${project.color}`,
              }"
            />{{ project.name }}{{ project.tld }}
          </a>
        </div>
      </div>
    </section>

    <!-- about -->
    <section
      id="about"
      class="border-border bg-panel relative z-[2] border-t border-b px-10 py-20"
    >
      <div
        class="mx-auto grid max-w-[1180px] items-start gap-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
      >
        <div class="flex flex-col gap-[18px]">
          <div
            class="flex items-center gap-3 text-[11.5px] tracking-[0.24em] text-[#7a7a85] uppercase"
          >
            <span class="h-px w-[22px] bg-[#7a7a85]" />
            about
          </div>
          <h2
            class="font-display m-0 font-black tracking-[-0.025em] text-[#f2f2f4]"
            style="font-size: clamp(30px, 3.6vw, 46px); line-height: 1.02"
          >
            A studio of<br />two, sort of.
          </h2>
        </div>

        <div class="flex flex-col gap-[26px]">
          <p
            class="m-0 text-[15.5px] leading-[1.8] text-[#b4b4bf]"
            style="text-wrap: pretty"
          >
            Neon Pixels is me and Grimicorn — my agent, my co-worker, and the
            reason commits show up at 3am. Everything under this roof solves a
            problem <em class="text-fg not-italic">I personally had</em>, and
            then kept going because it turns out other people had it too.
          </p>
          <p
            class="m-0 text-[15.5px] leading-[1.8] text-[#b4b4bf]"
            style="text-wrap: pretty"
          >
            It's also a playground. Each project doubles as an experiment in how
            far automated, agent-driven development can actually go when you let
            it off the leash. Some of it works beautifully. Some of it is on
            fire. Both are the point.
          </p>
          <div
            class="border-border bg-border grid gap-px border"
            style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))"
          >
            <div class="bg-panel flex flex-col gap-[7px] px-4 py-[18px]">
              <span
                class="font-display text-lime text-[30px] leading-none font-black"
                >4</span
              >
              <span
                class="text-fg-dim text-[10.5px] tracking-[0.14em] uppercase"
                >projects live-ish</span
              >
            </div>
            <div class="bg-panel flex flex-col gap-[7px] px-4 py-[18px]">
              <span
                class="font-display text-cyan text-[30px] leading-none font-black"
                >2</span
              >
              <span
                class="text-fg-dim text-[10.5px] tracking-[0.14em] uppercase"
                >team members</span
              >
            </div>
            <div class="bg-panel flex flex-col gap-[7px] px-4 py-[18px]">
              <span
                class="font-display text-amber text-[30px] leading-none font-black"
                >1</span
              >
              <span
                class="text-fg-dim text-[10.5px] tracking-[0.14em] uppercase"
                >of them sleeps</span
              >
            </div>
            <div class="bg-panel flex flex-col gap-[7px] px-4 py-[18px]">
              <span
                class="font-display text-pink text-[30px] leading-none font-black"
                >∞</span
              >
              <span
                class="text-fg-dim text-[10.5px] tracking-[0.14em] uppercase"
                >personal annoyances</span
              >
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- projects heading -->
    <div
      id="projects"
      class="relative z-[2] mx-auto max-w-[1180px] px-10 pt-16 pb-[34px]"
    >
      <div
        class="border-border flex items-baseline justify-between gap-5 border-b pb-4"
      >
        <div
          class="flex items-center gap-3 text-[11.5px] tracking-[0.24em] text-[#7a7a85] uppercase"
        >
          <span class="h-px w-[22px] bg-[#7a7a85]" />
          the projects
        </div>
        <span class="text-fg-faint text-[11px] tracking-[0.1em]">04 / 04</span>
      </div>
    </div>

    <!-- grimicorn -->
    <section
      id="grimicorn"
      class="border-border relative z-[2] overflow-hidden border-t px-10 py-[76px]"
      style="background: linear-gradient(100deg, #0d1206 0%, #08080a 58%)"
    >
      <div
        class="absolute top-0 right-0 left-0 h-px"
        style="background: linear-gradient(90deg, #b8ff2e, transparent 65%)"
      />
      <div
        class="animate-aurora pointer-events-none absolute top-[-30%] left-[-6%] h-[520px] w-[520px] rounded-full blur-[46px]"
        style="
          --np-aurora-dur: 28s;
          background: radial-gradient(
            circle,
            rgba(184, 255, 46, 0.18),
            transparent 62%
          );
        "
      />
      <div
        class="relative mx-auto grid max-w-[1180px] items-center gap-14 md:grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)]"
      >
        <div class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <span
              class="font-display bg-lime px-2 py-[3px] text-[12px] font-black tracking-[0.08em] text-[#08080a]"
              >LIVE</span
            >
            <span class="text-fg-dim text-[11px] tracking-[0.2em] uppercase"
              >01 — agent workflow</span
            >
          </div>
          <h3
            class="font-display m-0 font-black tracking-[-0.03em] text-[#f2f2f4]"
            style="font-size: clamp(38px, 5vw, 66px); line-height: 0.92"
          >
            grimicorn<span
              class="text-lime animate-flicker"
              style="text-shadow: 0 0 18px rgba(184, 255, 46, 0.6)"
              >.dev</span
            >
          </h3>
          <p
            class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-[#a8a8b3]"
            style="text-wrap: pretty"
          >
            The chaotic coding sidekick behind everything else on this page. An
            automated agent workflow that builds, breaks, and ships the other
            Neon Pixels projects while I'm asleep.
          </p>
          <a
            href="https://grimicorn.dev"
            target="_blank"
            rel="noopener noreferrer"
            class="cta-fill bg-lime self-start px-5 py-3 text-[13px] font-bold text-[#08080a]"
            style="box-shadow: 0 0 26px rgba(184, 255, 46, 0.35)"
            >visit grimicorn.dev →</a
          >
        </div>
        <div
          class="border border-[#23301a] bg-[#0a0d06]"
          style="box-shadow: 0 0 60px rgba(184, 255, 46, 0.1)"
        >
          <div
            class="flex items-center gap-2 border-b border-[#23301a] px-[14px] py-[11px]"
          >
            <span class="h-[9px] w-[9px] rounded-full bg-[#ff2ea6]" />
            <span class="h-[9px] w-[9px] rounded-full bg-[#ffc21f]" />
            <span class="h-[9px] w-[9px] rounded-full bg-[#b8ff2e]" />
            <span class="text-fg-dim ml-2 text-[11px]"
              >grimicorn-agent — zsh</span
            >
          </div>
          <div
            class="text-fg-subtle px-[18px] py-[18px] text-[12.5px] leading-[2.05]"
          >
            <div><span class="text-lime">grimicorn@dev</span> ~ % status</div>
            <div class="text-fg font-bold">UNLEASHED</div>
            <div
              v-for="line in GRIMICORN_TERMINAL"
              :key="line.text"
              class="text-purple"
            >
              {{ line.text }}
            </div>
            <div>
              <span class="text-lime">grimicorn@dev</span> ~ %
              <span
                class="bg-lime animate-blink inline-block h-[14px] w-2 align-[-2px]"
              />
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- wanderist -->
    <section
      id="wanderist"
      class="border-border relative z-[2] overflow-hidden border-t px-10 py-[76px]"
      style="background: linear-gradient(260deg, #04141a 0%, #08080a 58%)"
    >
      <div
        class="absolute top-0 right-0 left-0 h-px"
        style="background: linear-gradient(270deg, #22e0ff, transparent 65%)"
      />
      <div
        class="animate-aurora-reverse pointer-events-none absolute top-[-26%] right-[-6%] h-[520px] w-[520px] rounded-full blur-[46px]"
        style="
          --np-aurora-dur: 34s;
          background: radial-gradient(
            circle,
            rgba(34, 224, 255, 0.16),
            transparent 62%
          );
        "
      />
      <div
        class="relative mx-auto grid max-w-[1180px] items-center gap-14 md:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]"
      >
        <div
          class="flex flex-col gap-4 border border-[#12333f] bg-[#051216] p-[22px]"
          style="box-shadow: 0 0 60px rgba(34, 224, 255, 0.1)"
        >
          <div
            class="flex justify-between text-[11px] tracking-[0.16em] text-[#5a6d75] uppercase"
          >
            <span>trip log</span><span>47 / 50 states</span>
          </div>
          <div class="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-1">
            <div
              v-for="(state, index) in TRIP_CELLS"
              :key="index"
              :style="{
                aspectRatio: '1',
                background: TRIP_CELL_COLORS[state],
                boxShadow:
                  state === 'on' ? `0 0 8px ${BRAND_ACCENTS.cyan}` : 'none',
              }"
            />
          </div>
          <div class="flex gap-5 text-[11px] text-[#5a6d75]">
            <span>60k+ miles</span><span>26 states</span
            ><span>3 countries</span>
          </div>
        </div>
        <div class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <span
              class="font-display text-cyan border-cyan border px-2 py-[2px] text-[12px] font-black tracking-[0.08em]"
              >IN PROGRESS</span
            >
            <span class="text-fg-dim text-[11px] tracking-[0.2em] uppercase"
              >02 — travel</span
            >
          </div>
          <h3
            class="font-display m-0 font-black tracking-[-0.03em] text-[#f2f2f4]"
            style="font-size: clamp(38px, 5vw, 66px); line-height: 0.92"
          >
            wanderist<span
              class="text-cyan"
              style="text-shadow: 0 0 18px rgba(34, 224, 255, 0.6)"
              >.io</span
            >
          </h3>
          <p
            class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-[#a8a8b3]"
            style="text-wrap: pretty"
          >
            A travel blog and tracker in one. Log where you've been, plot it,
            write about it — without gluing together four apps and a spreadsheet
            to do it.
          </p>
          <a
            href="https://wanderist.io"
            target="_blank"
            rel="noopener noreferrer"
            class="cta-outline text-cyan border-cyan self-start border px-5 py-3 text-[13px] font-bold"
            style="--accent: #22e0ff"
            >visit wanderist.io →</a
          >
        </div>
      </div>
    </section>

    <!-- basin -->
    <section
      id="basin"
      class="border-border relative z-[2] overflow-hidden border-t px-10 py-[76px]"
      style="background: linear-gradient(100deg, #170f02 0%, #08080a 58%)"
    >
      <div
        class="absolute top-0 right-0 left-0 h-px"
        style="background: linear-gradient(90deg, #ffc21f, transparent 65%)"
      />
      <div
        class="animate-aurora pointer-events-none absolute bottom-[-34%] left-[2%] h-[520px] w-[520px] rounded-full blur-[46px]"
        style="
          --np-aurora-dur: 30s;
          background: radial-gradient(
            circle,
            rgba(255, 194, 31, 0.15),
            transparent 62%
          );
        "
      />
      <div
        class="relative mx-auto grid max-w-[1180px] items-center gap-14 md:grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)]"
      >
        <div class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <span
              class="font-display text-amber border-amber border px-2 py-[2px] text-[12px] font-black tracking-[0.08em]"
              >IN PROGRESS</span
            >
            <span class="text-fg-dim text-[11px] tracking-[0.2em] uppercase"
              >03 — syndication</span
            >
          </div>
          <h3
            class="font-display m-0 font-black tracking-[-0.03em] text-[#f2f2f4]"
            style="font-size: clamp(38px, 5vw, 66px); line-height: 0.92"
          >
            basin<span
              class="text-amber"
              style="text-shadow: 0 0 18px rgba(255, 194, 31, 0.6)"
              >.fm</span
            >
          </h3>
          <p
            class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-[#a8a8b3]"
            style="text-wrap: pretty"
          >
            Everything you consume, in one stream. RSS, podcasts, YouTube and
            Bluesky today — Twitter, Instagram and whatever else annoys me next.
          </p>
          <a
            href="https://basin.fm"
            target="_blank"
            rel="noopener noreferrer"
            class="cta-outline text-amber border-amber self-start border px-5 py-3 text-[13px] font-bold"
            style="--accent: #ffc21f"
            >visit basin.fm →</a
          >
        </div>
        <div
          class="flex flex-col gap-px border border-[#2e2410] bg-[#2e2410]"
          style="box-shadow: 0 0 60px rgba(255, 194, 31, 0.09)"
        >
          <div
            v-for="item in BASIN_FEED"
            :key="item.title"
            class="flex items-center gap-[14px] bg-[#120d03] px-[18px] py-[15px]"
          >
            <span
              class="h-2 w-2 flex-none"
              :style="{
                background: item.dot,
                boxShadow: item.glow
                  ? `0 0 8px ${BRAND_ACCENTS.amber}`
                  : 'none',
              }"
            />
            <span
              class="flex-1 text-[13px]"
              :style="{ color: item.titleColor }"
              >{{ item.title }}</span
            >
            <span class="text-fg-dim text-[11px]">{{ item.kind }}</span>
          </div>
          <div
            class="text-fg-dim flex items-center gap-[10px] bg-[#0d0a02] px-[18px] py-[13px] text-[11px]"
          >
            <span class="text-amber">+ twitter</span
            ><span class="text-amber">+ instagram</span
            ><span class="ml-auto">maybe someday</span>
          </div>
        </div>
      </div>
    </section>

    <!-- markpost -->
    <section
      id="markpost"
      class="border-border relative z-[2] overflow-hidden border-t px-10 py-[76px]"
      style="background: linear-gradient(260deg, #180618 0%, #08080a 58%)"
    >
      <div
        class="absolute top-0 right-0 left-0 h-px"
        style="background: linear-gradient(270deg, #ff2ea6, transparent 65%)"
      />
      <div
        class="animate-aurora-reverse pointer-events-none absolute top-[-20%] right-0 h-[540px] w-[540px] rounded-full blur-[46px]"
        style="
          --np-aurora-dur: 36s;
          background: radial-gradient(
            circle,
            rgba(255, 46, 166, 0.16),
            transparent 62%
          );
        "
      />
      <div
        class="relative mx-auto grid max-w-[1180px] items-center gap-14 md:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]"
      >
        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-[18px]">
          <div
            class="flex flex-col gap-[11px] border border-[#3d1029] bg-[#150610] p-[18px]"
          >
            <span
              class="text-[10.5px] tracking-[0.16em] text-[#7a5566] uppercase"
              >in</span
            >
            <span class="text-fg text-[12.5px]">POST /webhook</span>
            <span class="text-fg-subtle text-[12.5px]"
              >✉ notes@markpost.io</span
            >
            <span class="text-fg-subtle text-[12.5px]"
              >{ "title": "idea" }</span
            >
          </div>
          <div
            class="text-pink animate-flicker flex items-center justify-center text-[22px]"
            style="text-shadow: 0 0 14px rgba(255, 46, 166, 0.8)"
            aria-hidden="true"
          >
            →
          </div>
          <div
            class="flex flex-col gap-[11px] border border-[#3d1029] bg-[#150610] p-[18px]"
            style="box-shadow: 0 0 50px rgba(255, 46, 166, 0.12)"
          >
            <span
              class="text-[10.5px] tracking-[0.16em] text-[#7a5566] uppercase"
              >out</span
            >
            <span class="text-pink text-[12.5px]">~/vault/idea.md</span>
            <span class="text-fg-subtle text-[12.5px]"># idea</span>
            <span class="text-fg-subtle text-[12.5px]"
              >created: 2026-08-08</span
            >
          </div>
        </div>
        <div class="flex flex-col gap-5">
          <div class="flex items-center gap-3">
            <span
              class="font-display text-pink border-pink border px-2 py-[2px] text-[12px] font-black tracking-[0.08em]"
              >IN PROGRESS</span
            >
            <span class="text-fg-dim text-[11px] tracking-[0.2em] uppercase"
              >04 — capture</span
            >
          </div>
          <h3
            class="font-display m-0 font-black tracking-[-0.03em] text-[#f2f2f4]"
            style="font-size: clamp(38px, 5vw, 66px); line-height: 0.92"
          >
            markpost<span
              class="text-pink"
              style="text-shadow: 0 0 18px rgba(255, 46, 166, 0.6)"
              >.io</span
            >
          </h3>
          <p
            class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-[#a8a8b3]"
            style="text-wrap: pretty"
          >
            Send a webhook or an email, get a Markdown file on your own
            filesystem. Built for Obsidian, works with anything that reads
            Markdown.
          </p>
          <a
            href="https://markpost.io"
            target="_blank"
            rel="noopener noreferrer"
            class="cta-outline text-pink border-pink self-start border px-5 py-3 text-[13px] font-bold"
            style="--accent: #ff2ea6"
            >visit markpost.io →</a
          >
        </div>
      </div>
    </section>

    <!-- footer -->
    <footer
      class="border-border bg-panel relative z-[2] border-t px-10 pt-[52px] pb-10"
    >
      <div
        class="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-7"
      >
        <div class="flex items-center gap-[11px]">
          <svg
            width="18"
            height="18"
            viewBox="0 0 34 34"
            class="block"
            aria-hidden="true"
          >
            <rect x="0" y="22" width="10" height="10" fill="#22e0ff" />
            <rect x="12" y="11" width="10" height="10" fill="#b8ff2e" />
            <rect x="24" y="0" width="10" height="10" fill="#ff2ea6" />
          </svg>
          <span class="font-display text-[13px] font-black text-[#f2f2f4]"
            >NEON<span class="text-lime">PIXELS</span></span
          >
        </div>
        <div class="text-fg-dim flex flex-wrap gap-[22px] text-[12px]">
          <a
            v-for="project in PROJECTS"
            :key="project.id"
            :href="project.url"
            target="_blank"
            rel="noopener noreferrer"
            class="footer-link text-fg-dim"
            :style="{ '--accent': project.color }"
            >{{ project.name }}{{ project.tld }}</a
          >
        </div>
        <span class="text-fg-dim text-[11.5px]"
          >© 2026 · built dark · shipped colorful</span
        >
      </div>
    </footer>
  </div>
</template>

<style scoped>
.pill {
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}
.pill:hover {
  background: var(--pill-bg-hover);
  border-color: var(--accent);
}

.nav-link {
  transition: color 0.2s ease;
}
.nav-link:hover {
  color: #e8e8ea;
}

.footer-link {
  transition: color 0.2s ease;
}
.footer-link:hover {
  color: var(--accent);
}

.cta-fill {
  transition: box-shadow 0.2s ease;
}
.cta-fill:hover {
  box-shadow: 0 0 42px rgba(184, 255, 46, 0.6);
}

.cta-outline {
  transition:
    background 0.2s ease,
    color 0.2s ease;
}
.cta-outline:hover {
  background: var(--accent);
  color: #08080a;
}
</style>
