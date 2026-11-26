<script setup lang="ts">
import { BRAND_ACCENTS } from "../brand";
import { MAIN_CONTENT_ID } from "../a11y";
import { PROJECTS } from "../data/projects";
import {
  basinDotClass,
  projectStyleClass,
  tripCellClass,
  type TripCellState,
} from "../generatedStyles";
import { STATES_TOTAL, STATES_VISITED, STATE_VISITS } from "../data/states";
import ProjectSection from "./ProjectSection.vue";
import ContactForm from "./ContactForm.vue";
import SiteNav from "./SiteNav.vue";

// Zero-padded project total for the "NN / NN" counter, so the header tracks the
// data instead of a hand-typed number. PROJECTS is a static import, so a plain
// constant is enough — no reactivity to track.
const paddedProjectCount = String(PROJECTS.length).padStart(2, "0");

// Visited states cycle through the three lit brightnesses for the heatmap's
// visited / partly / faint texture; unvisited states take the empty tint.
// Derived from STATE_VISITS so the grid always renders STATES_TOTAL cells with
// STATES_VISITED lit — the picture can't drift from the caption. Typing the
// arrays (rather than casting the result) keeps a typo like "lo" a compile
// error instead of a missing class, and `Exclude<_, "off">` stops the empty
// tint being listed as a lit brightness. The fills are generated classes (see
// generatedStyles.ts).
const LIT_CELL_STATES: Exclude<TripCellState, "off">[] = ["on", "mid", "low"];

const TRIP_CELLS: TripCellState[] = STATE_VISITS.map((visited, cellIndex) => {
  if (!visited) {
    return "off";
  }
  return LIT_CELL_STATES[cellIndex % LIT_CELL_STATES.length];
});

// The FarFlung visual carries trip-scale figures, so unlike the other
// decorative mockups it is exposed to assistive tech as a single labelled
// image rather than hidden. The caption "47 / 50 states" is the canonical
// figure; the footer total is reconciled to the same 47 (it previously read a
// contradictory 26). The states figure is owned by data/states.ts, so the
// caption, this label, and the heatmap grid (one cell per state, exactly
// STATES_VISITED lit — see TRIP_CELLS) all read from one source and can't drift
// apart the way 26/47 did.
const FARFLUNG_STATES_VISITED = STATES_VISITED;
const FARFLUNG_STATES_TOTAL = STATES_TOTAL;
const FARFLUNG_MILES_TRAVELED = 60000;
const FARFLUNG_COUNTRIES = 3;

// Group thousands without Intl: a module-scope toLocaleString would depend on
// the build machine's ICU data and could surface as a hydration mismatch on the
// static aria-label. This one regex formats the trip mileage for both display
// forms below off the single numeric source.
function groupThousands(value: number) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Two display forms of the one mileage figure: the compact "60k+" the mockup
// shows and the grouped "60,000+" the label announces. Both floor to thousands,
// so the "+" is always truthful (the real value is at least what's shown), and
// both derive from FARFLUNG_MILES_TRAVELED so they can't drift.
const FARFLUNG_MILES_SHORT = `${Math.floor(FARFLUNG_MILES_TRAVELED / 1000)}k+`;
const FARFLUNG_MILES_LABEL = `${groupThousands(FARFLUNG_MILES_TRAVELED)}+`;
const FARFLUNG_MOCKUP_LABEL = `FarFlung trip log: ${FARFLUNG_STATES_VISITED} of ${FARFLUNG_STATES_TOTAL} US states visited, ${FARFLUNG_MILES_LABEL} miles traveled across ${FARFLUNG_COUNTRIES} countries.`;

// Basin aggregates a mixed feed; the leading dot fades with recency and only
// the freshest item glows (basinDotClass, see generatedStyles.ts). Title colors
// are literal classes so the JIT scanner sees them.
const BASIN_FEED = [
  {
    title: "Syntax — 900: The One About Agents",
    kind: "podcast",
    titleClass: "text-[#e8e8ea]",
  },
  {
    title: "CSS-Tricks — Anchor positioning, finally",
    kind: "rss",
    titleClass: "text-[#c4c4cd]",
  },
  {
    title: "@dan.bsky.social — shipped something at 3am",
    kind: "bluesky",
    titleClass: "text-[#c4c4cd]",
  },
  {
    title: "Fireship — 100 seconds of something new",
    kind: "youtube",
    titleClass: "text-[#c4c4cd]",
  },
];

const GRIMICORN_TERMINAL = [
  { text: "[03:14] merged a PR you haven't read" },
  { text: "[03:16] shipped farflung map tiles" },
  { text: "[03:19] broke staging. on purpose." },
];
</script>

<template>
  <div class="bg-bg text-fg relative font-mono">
    <!-- drifting grid backdrop -->
    <div
      class="animate-drift ambient-decoration grid-backdrop pointer-events-none fixed inset-0 z-0"
    />

    <!-- header -->
    <header
      class="border-border sticky top-0 z-30 flex items-center justify-between gap-6 border-b bg-[#08080ae6] px-10 py-[22px] backdrop-blur-md"
    >
      <a href="#top" class="flex items-center gap-[11px]">
        <svg
          width="20"
          height="20"
          viewBox="0 0 34 34"
          class="block flex-none"
          aria-hidden="true"
        >
          <rect
            x="0"
            y="22"
            width="10"
            height="10"
            :fill="BRAND_ACCENTS.cyan"
          />
          <rect
            x="12"
            y="11"
            width="10"
            height="10"
            :fill="BRAND_ACCENTS.lime"
          />
          <rect
            x="24"
            y="0"
            width="10"
            height="10"
            :fill="BRAND_ACCENTS.pink"
          />
        </svg>
        <span
          class="font-display text-[15px] font-black tracking-[-0.01em] text-[#f2f2f4]"
        >
          NEON<span
            class="animate-sweep wordmark-gradient bg-clip-text text-transparent [--np-sweep-dur:7s]"
            >PIXELS</span
          >
        </span>
      </a>
      <SiteNav />
    </header>

    <!-- tabindex="-1" keeps <main> out of the Tab order while letting the skip
         link (in AppLayout) move focus here on browsers that don't set the
         focus navigation starting point from fragment nav (Safari) -->
    <main :id="MAIN_CONTENT_ID" tabindex="-1">
      <!-- hero -->
      <section
        id="top"
        class="relative z-[2] overflow-hidden px-10 pt-28 pb-24"
      >
        <div
          class="animate-aurora ambient-decoration hero-aurora-lime pointer-events-none absolute top-[-30%] left-[8%] h-[640px] w-[640px] rounded-full blur-[38px]"
        />
        <div
          class="animate-aurora-reverse ambient-decoration hero-aurora-pink pointer-events-none absolute top-[-14%] right-[2%] h-[560px] w-[560px] rounded-full blur-[38px] [--np-aurora-dur:32s]"
        />
        <div
          class="animate-aurora ambient-decoration hero-aurora-cyan pointer-events-none absolute bottom-[-24%] left-[34%] h-[520px] w-[520px] rounded-full blur-[40px] [--np-aurora-dur:38s]"
        />

        <div class="relative mx-auto flex max-w-[1180px] flex-col gap-[34px]">
          <div
            class="flex items-center gap-[14px] text-[11.5px] tracking-[0.24em] text-[#7a7a85] uppercase"
          >
            <span class="bg-lime hero-rule-glow h-px w-[26px]" />
            a very small studio · a lot of side projects
          </div>

          <h1
            class="font-display m-0 text-[clamp(56px,9vw,132px)] leading-[0.86] font-black tracking-[-0.035em] text-balance text-[#f4f4f6]"
          >
            WE BUILD THE<br />
            <span
              class="animate-sweep wordmark-gradient bg-clip-text text-transparent"
              >MISSING APPS</span
            >
          </h1>

          <p
            class="m-0 max-w-[640px] text-[15.5px] leading-[1.75] text-pretty text-[#a8a8b3]"
          >
            Neon Pixels is one human and one very caffeinated agent, shipping
            the tools we kept wishing existed. Every project here started as a
            personal annoyance and escaped into production.
            <span class="text-fg">You're welcome to use them.</span>
          </p>

          <div class="flex flex-wrap gap-[10px]">
            <a
              v-for="project in PROJECTS"
              :key="project.id"
              :href="`#${project.id}`"
              class="pill flex items-center gap-[9px] border px-[15px] py-[9px] text-[12.5px]"
              :class="projectStyleClass(project.id, 'pill')"
            >
              <span
                class="pill-dot h-[6px] w-[6px]"
                :class="projectStyleClass(project.id, 'pill-dot')"
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
              class="font-display m-0 text-[clamp(30px,3.6vw,46px)] leading-[1.02] font-black tracking-[-0.025em] text-[#f2f2f4]"
            >
              A studio of<br />two, sort of.
            </h2>
          </div>

          <div class="flex flex-col gap-[26px]">
            <p
              class="m-0 text-[15.5px] leading-[1.8] text-pretty text-[#b4b4bf]"
            >
              Neon Pixels is me and Grimicorn — my agent, my co-worker, and the
              reason commits show up at 3am. Everything under this roof solves a
              problem <em class="text-fg not-italic">I personally had</em>, and
              then kept going because it turns out other people had it too.
            </p>
            <p
              class="m-0 text-[15.5px] leading-[1.8] text-pretty text-[#b4b4bf]"
            >
              It's also a playground. Each project doubles as an experiment in
              how far automated, agent-driven development can actually go when
              you let it off the leash. Some of it works beautifully. Some of it
              is on fire. Both are the point.
            </p>
            <div
              class="border-border bg-border grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px border"
            >
              <div class="bg-panel flex flex-col gap-[7px] px-4 py-[18px]">
                <span
                  class="font-display text-lime text-[30px] leading-none font-black"
                  >{{ PROJECTS.length }}</span
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
          <span class="text-fg-faint text-[11px] tracking-[0.1em]"
            >{{ paddedProjectCount }} / {{ paddedProjectCount }}</span
          >
        </div>
      </div>

      <!-- projects: one data-driven section per PROJECTS entry; each keeps its
         bespoke visual in the #visual slot. reverse alternates the layout. -->
      <ProjectSection
        v-for="(project, projectIndex) in PROJECTS"
        :key="project.id"
        :project="project"
        :reverse="projectIndex % 2 === 1"
      >
        <!-- Every branch below is a fabricated, decorative product mockup, so
             its root div must carry aria-hidden="true" to keep the illustrative
             chrome out of the accessibility tree. The "hides each decorative
             project visual" test enforces this for any new branch. -->
        <template #visual>
          <div
            v-if="project.id === 'grimicorn'"
            class="glow-grimicorn border border-[#23301a] bg-[#0a0d06]"
            aria-hidden="true"
          >
            <div
              class="flex items-center gap-2 border-b border-[#23301a] px-[14px] py-[11px]"
            >
              <span class="bg-pink h-[9px] w-[9px] rounded-full" />
              <span class="bg-amber h-[9px] w-[9px] rounded-full" />
              <span class="bg-lime h-[9px] w-[9px] rounded-full" />
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

          <div
            v-else-if="project.id === 'farflung'"
            class="glow-farflung flex flex-col gap-4 border border-[#12333f] bg-[#051216] p-[22px]"
            role="img"
            :aria-label="FARFLUNG_MOCKUP_LABEL"
          >
            <div
              class="text-farflung-label flex justify-between text-[11px] tracking-[0.16em] uppercase"
            >
              <span>trip log</span
              ><span
                >{{ FARFLUNG_STATES_VISITED }} /
                {{ FARFLUNG_STATES_TOTAL }} states</span
              >
            </div>
            <!-- 10 columns lays the 50 state cells out as a clean 10x5 block;
                 the taller card (vs. the old 3-row strip) is deliberate now that
                 the grid holds all 50 states. -->
            <div
              class="grid grid-cols-[repeat(10,minmax(0,1fr))] gap-1"
              data-testid="trip-log-heatmap"
            >
              <!-- Fill via --trip-cell-bg, not a plain `background`, so the
                   forced-colors override in style.css's `.trip-cell` rule
                   can win the cascade — see that rule for why. -->
              <div
                v-for="(state, cellIndex) in TRIP_CELLS"
                :key="cellIndex"
                data-testid="trip-log-cell"
                class="trip-cell aspect-square"
                :class="tripCellClass(state)"
                :data-visited="state !== 'off'"
              />
            </div>
            <div class="text-farflung-label flex gap-5 text-[11px]">
              <span>{{ FARFLUNG_MILES_SHORT }} miles</span
              ><span>{{ FARFLUNG_STATES_VISITED }} states</span
              ><span>{{ FARFLUNG_COUNTRIES }} countries</span>
            </div>
          </div>

          <div
            v-else-if="project.id === 'basin'"
            class="glow-basin flex flex-col gap-px border border-[#2e2410] bg-[#2e2410]"
            aria-hidden="true"
          >
            <div
              v-for="(item, feedIndex) in BASIN_FEED"
              :key="item.title"
              class="flex items-center gap-[14px] bg-[#120d03] px-[18px] py-[15px]"
            >
              <span
                class="h-2 w-2 flex-none"
                :class="basinDotClass(feedIndex)"
              />
              <span class="flex-1 text-[13px]" :class="item.titleClass">{{
                item.title
              }}</span>
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

          <div
            v-else-if="project.id === 'markpost'"
            class="grid grid-cols-[1fr_auto_1fr] items-center gap-[18px]"
            aria-hidden="true"
          >
            <div
              class="flex flex-col gap-[11px] border border-[#3d1029] bg-[#150610] p-[18px]"
            >
              <span
                class="text-markpost-label text-[10.5px] tracking-[0.16em] uppercase"
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
              class="text-pink animate-flicker glow-markpost-arrow flex items-center justify-center text-[22px]"
            >
              →
            </div>
            <div
              class="glow-markpost-out flex flex-col gap-[11px] border border-[#3d1029] bg-[#150610] p-[18px]"
            >
              <span
                class="text-markpost-label text-[10.5px] tracking-[0.16em] uppercase"
                >out</span
              >
              <span class="text-pink text-[12.5px]">~/vault/idea.md</span>
              <span class="text-fg-subtle text-[12.5px]"># idea</span>
              <span class="text-fg-subtle text-[12.5px]"
                >created: 2026-08-08</span
              >
            </div>
          </div>
        </template>
      </ProjectSection>
    </main>

    <!-- contact: placed right above the footer, so it's the closing call to
         action after the projects rather than the first thing on the page. -->
    <ContactForm />

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
            <rect
              x="0"
              y="22"
              width="10"
              height="10"
              :fill="BRAND_ACCENTS.cyan"
            />
            <rect
              x="12"
              y="11"
              width="10"
              height="10"
              :fill="BRAND_ACCENTS.lime"
            />
            <rect
              x="24"
              y="0"
              width="10"
              height="10"
              :fill="BRAND_ACCENTS.pink"
            />
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
            :class="projectStyleClass(project.id, 'accent')"
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

.footer-link {
  transition: color 0.2s ease;
}
.footer-link:hover {
  color: var(--accent);
}
</style>
