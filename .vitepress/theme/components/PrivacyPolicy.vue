<script setup lang="ts">
import { WORDMARK_GRADIENT } from "../brand";
import { MAIN_CONTENT_ID } from "../a11y";
import { GA_MEASUREMENT_ID } from "../analytics/loadGoogleAnalytics";
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

      <p class="text-fg-muted m-0 mb-8 text-[15.5px] leading-[1.8]">
        This is a small studio site with one analytics tool bolted on. This page
        explains, in plain language, what that tool collects, why, and for how
        long.
      </p>

      <section class="mb-10">
        <h2
          class="font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]"
        >
          What we collect
        </h2>
        <p class="text-fg-muted m-0 mb-4 text-[15.5px] leading-[1.8]">
          If you accept the analytics banner, this site loads Google Analytics 4
          (GA4), which records:
        </p>
        <ul
          class="text-fg-muted m-0 mb-2 flex list-none flex-col gap-2 pl-0 text-[15.5px] leading-[1.7]"
        >
          <li class="flex gap-3">
            <span class="text-lime">▸</span>
            <span
              >Pageviews - which pages on this site you visit and roughly how
              long you stay.</span
            >
          </li>
          <li class="flex gap-3">
            <span class="text-lime">▸</span>
            <span
              >Interaction events - things like clicking one of the project
              links (grimicorn.dev, wanderist.io, basin.fm, markpost.io), so we
              can tell which project people are actually curious about.</span
            >
          </li>
          <li class="flex gap-3">
            <span class="text-lime">▸</span>
            <span
              >Standard technical details GA4 collects automatically for any
              hit: an approximate location derived from IP address (not the IP
              address itself), device/browser type, and referring site.</span
            >
          </li>
        </ul>
        <p class="text-fg-muted m-0 text-[15.5px] leading-[1.8]">
          We don't collect names, email addresses, or any other information
          you'd have to type in - there's nowhere on this site to type anything.
        </p>
      </section>

      <section class="mb-10">
        <h2
          class="font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]"
        >
          Why
        </h2>
        <p class="text-fg-muted m-0 text-[15.5px] leading-[1.8]">
          Purely to see which of the four project links people click, so we have
          a rough sense of what's worth spending more time on. Nothing collected
          here is used to advertise to you, build a profile of you, or follow
          you across other sites.
        </p>
      </section>

      <section class="mb-10">
        <h2
          class="font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]"
        >
          How long it's kept
        </h2>
        <p class="text-fg-muted m-0 text-[15.5px] leading-[1.8]">
          This site uses Google's standard GA4 configuration - we haven't
          customized the retention window. Google's own documentation caps
          event-level retention at a maximum of 14 months, after which it's
          automatically deleted from GA4's servers.
        </p>
      </section>

      <section class="mb-10">
        <h2
          class="font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]"
        >
          Who else sees it
        </h2>
        <p class="text-fg-muted m-0 text-[15.5px] leading-[1.8]">
          Nobody. Data goes to Google as the analytics processor and nowhere
          else - it isn't sold, shared with advertisers, or handed to any other
          third party.
        </p>
      </section>

      <section>
        <h2
          class="font-display m-0 mb-4 text-[20px] font-black tracking-[-0.015em] text-[#f2f2f4]"
        >
          Your choice
        </h2>
        <p class="text-fg-muted m-0 mb-4 text-[15.5px] leading-[1.8]">
          Nothing loads until you accept the banner, and you can change your
          mind at any time using the "Analytics choice" control that stays
          on-screen once you've decided. If your browser sends a Do Not Track or
          Global Privacy Control signal, analytics never loads at all and you're
          never asked.
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
