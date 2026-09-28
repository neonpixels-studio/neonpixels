<script setup lang="ts">
import { WORDMARK_GRADIENT } from "../brand";
import { MAIN_CONTENT_ID } from "../a11y";
import { GA_MEASUREMENT_ID } from "../analytics/loadGoogleAnalytics";
import { MANAGE_CHOICE_LABEL } from "../analytics/analyticsConsent";
import { PROJECTS } from "../data/projects";

// Shared across every section heading/body paragraph below so the five
// sections read consistently and a font-size/color tweak only has one place
// to land — mirrors how NeonPixelsPage.vue composes its own repeated inline
// style objects (auroraGlow, cardGlow) from one definition instead of
// restating each section's markup by hand.
const SECTION_HEADING_CLASS =
  "font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]";
const BODY_TEXT_CLASS = "text-fg-muted m-0 text-[15.5px] leading-[1.8]";

// PROJECTS is the same source NeonPixelsPage.vue's hero pills and footer
// links read from - deriving the hostnames and count from it here means
// adding/removing/renaming a project can't leave this page quietly wrong
// the way a hand-typed domain list and "the four project links" would.
const PROJECT_COUNT = PROJECTS.length;
const PROJECT_HOSTNAMES = PROJECTS.map(
  (project) => new URL(project.url).hostname,
).join(", ");

// What GA4 actually records once a visitor accepts the banner. Kept as data
// (rendered via v-for below) rather than three hand-written <li> blocks so a
// future addition — e.g. a CTA-click event — is a one-line array edit, not a
// fourth copy-pasted list item.
const COLLECTED_DATA_POINTS = [
  "Pageviews - which pages on this site you visit and roughly how long you stay.",
  `Interaction events GA4 records automatically via its Enhanced Measurement setting - such as outbound clicks on the project links (${PROJECT_HOSTNAMES}) - so we can tell which project people are actually curious about.`,
  "Standard technical details GA4 collects automatically for any hit: an approximate location derived from IP address (not the IP address itself), device/browser type, and referring site.",
  'Two first-party cookies GA4 itself sets once you accept - _ga and _ga_<container-id> - which hold a random id so repeat visits can be counted as the same visitor. Both expire automatically after about 2 years, or sooner if you decline (see "Your choice" below).',
];
</script>

<template>
  <div class="bg-bg text-fg relative font-mono">
    <header
      class="border-border sticky top-0 z-30 flex items-center justify-between gap-6 border-b px-10 py-[22px] backdrop-blur-md"
      style="background: #08080ae6"
    >
      <a href="/" class="flex items-center gap-[11px]">
        <span
          class="font-display text-[15px] font-black tracking-[-0.01em] text-[#f2f2f4]"
        >
          NEON<span
            class="bg-clip-text text-transparent"
            :style="{ backgroundImage: WORDMARK_GRADIENT }"
            >PIXELS</span
          >
        </span>
      </a>
      <a href="/" class="text-fg-subtle nav-link text-[12.5px]">
        ← back to home
      </a>
    </header>

    <main
      :id="MAIN_CONTENT_ID"
      tabindex="-1"
      class="relative z-[2] mx-auto max-w-[720px] px-10 py-20"
    >
      <div
        class="text-lime mb-6 flex items-center gap-3 text-[11.5px] tracking-[0.24em] uppercase"
      >
        <span class="bg-lime h-px w-6" />
        privacy
      </div>

      <h1
        class="font-display m-0 mb-8 font-black tracking-[-0.025em] text-[#f2f2f4]"
        style="font-size: clamp(30px, 3.6vw, 46px); line-height: 1.02"
      >
        Privacy Policy
      </h1>

      <p :class="BODY_TEXT_CLASS" class="mb-8">
        This is a small studio site with one analytics tool bolted on. This page
        explains, in plain language, what that tool collects, why, and for how
        long.
      </p>

      <section class="mb-10">
        <h2 :class="SECTION_HEADING_CLASS">What we collect</h2>
        <p :class="BODY_TEXT_CLASS" class="mb-4">
          If you accept the analytics banner, this site loads Google Analytics 4
          (GA4), which records:
        </p>
        <ul
          class="text-fg-muted m-0 mb-2 flex list-none flex-col gap-2 pl-0 text-[15.5px] leading-[1.7]"
        >
          <li
            v-for="dataPoint in COLLECTED_DATA_POINTS"
            :key="dataPoint"
            class="flex gap-3"
          >
            <span class="text-lime">▸</span>
            <span>{{ dataPoint }}</span>
          </li>
        </ul>
        <p :class="BODY_TEXT_CLASS">
          We don't collect names, email addresses, or any other information
          you'd have to type in - there's nowhere on this site to type anything.
        </p>
      </section>

      <section class="mb-10">
        <h2 :class="SECTION_HEADING_CLASS">Why</h2>
        <p :class="BODY_TEXT_CLASS">
          To see which pages get read and which of the {{ PROJECT_COUNT }}
          project links get clicked, so we have a rough sense of what's worth
          spending more time on. Nothing collected here is used to advertise to
          you, build a profile of you, or follow you across other sites.
        </p>
      </section>

      <section class="mb-10">
        <h2 :class="SECTION_HEADING_CLASS">How long it's kept</h2>
        <p :class="BODY_TEXT_CLASS">
          This site uses Google Analytics 4's own data retention controls, which
          cap event-level data at a maximum of 14 months before Google
          automatically deletes it - the exact window is a setting on the GA4
          property itself, not something this codebase controls. The _ga and
          _ga_* cookies mentioned above expire on their own after about 2 years,
          or are cleared immediately if you decline via the consent banner.
        </p>
      </section>

      <section class="mb-10">
        <h2 :class="SECTION_HEADING_CLASS">Who else sees it</h2>
        <p :class="BODY_TEXT_CLASS">
          Analytics data goes to Google, who processes it as described in
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            class="nav-link text-fg-subtle underline"
            >Google's own Privacy Policy</a
          >. This site has no other analytics, advertising, or tracking service
          embedded in it, and we don't sell or otherwise share this data
          ourselves.
        </p>
      </section>

      <section>
        <h2 :class="SECTION_HEADING_CLASS">Your choice</h2>
        <p :class="BODY_TEXT_CLASS" class="mb-4">
          Nothing loads until you accept the banner, and you can change your
          mind at any time using the "{{ MANAGE_CHOICE_LABEL }}" control that
          stays on-screen once you've decided. If your browser sends a Do Not
          Track or Global Privacy Control signal, analytics never loads at all
          and you're never asked.
        </p>
        <p class="text-fg-dim m-0 text-[13px] leading-[1.7]">
          GA4 measurement ID: {{ GA_MEASUREMENT_ID }}
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.nav-link {
  transition: color 0.2s ease;
}
.nav-link:hover {
  color: #e8e8ea;
}
</style>
