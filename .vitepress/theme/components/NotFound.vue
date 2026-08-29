<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { WORDMARK_GRADIENT } from "../brand";
import { MAIN_CONTENT_ID } from "../a11y";

const MISSING_LINES = [
  "no such page, only pixels",
  "404 pixels, 0 pages found",
  "this route shipped dark and never came back",
  "the app you wanted is still an idea",
  "page last seen escaping into production",
];

const requestedPath = ref("");
const lineIndex = ref(0);

const missingLine = computed(() => MISSING_LINES[lineIndex.value]);
const displayPath = computed(() => requestedPath.value || "/the-void");

onMounted(() => {
  requestedPath.value = window.location.pathname;
  lineIndex.value = Math.floor(Math.random() * MISSING_LINES.length);
});
</script>

<template>
  <!-- The 404 view has no header/nav to bypass, so its whole content is the
       primary landmark. tabindex="-1" lets the shared skip link (in AppLayout)
       move focus here, keeping bypass-blocks satisfied on 404 as well as /. -->
  <main
    :id="MAIN_CONTENT_ID"
    tabindex="-1"
    class="bg-bg text-fg relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-16 font-mono sm:px-8"
  >
    <!-- ambient glow -->
    <div
      class="animate-aurora pointer-events-none absolute top-[-200px] right-[-160px] h-[680px] w-[680px] blur-[24px]"
      style="
        background: radial-gradient(
          circle,
          rgba(34, 224, 255, 0.18),
          rgba(255, 46, 166, 0.09) 45%,
          transparent 70%
        );
      "
    />

    <div class="relative w-full max-w-[680px] text-center">
      <!-- crumb -->
      <div
        class="text-lime mb-6 flex items-center justify-center gap-3 text-xs tracking-[0.16em] uppercase"
      >
        <span class="bg-lime inline-block h-px w-6" />
        error 404 — page not found
        <span class="bg-lime inline-block h-px w-6" />
      </div>

      <!-- big neon 404 -->
      <h1
        class="font-display animate-sweep m-0 bg-clip-text font-black tracking-[-0.04em] text-transparent select-none"
        :style="{
          fontSize: 'clamp(6rem, 22vw, 12rem)',
          lineHeight: '0.9',
          backgroundImage: WORDMARK_GRADIENT,
        }"
      >
        404
      </h1>

      <!-- headline -->
      <h2
        class="font-display mt-2 mb-5 text-[26px] leading-[1.1] font-black tracking-[-0.02em] sm:text-[34px]"
      >
        this pixel never rendered.
      </h2>

      <!-- body -->
      <p class="text-fg-muted mx-auto mb-9 max-w-[440px] text-sm leading-[1.8]">
        The page you wanted got refactored, renamed, or shipped dark so prod
        wouldn't be. No worries — head back to base and we'll pretend this never
        happened.
      </p>

      <!-- actions -->
      <div class="mb-12 flex flex-wrap justify-center gap-[14px]">
        <a
          href="/"
          class="text-bg animate-sweep rounded-none px-[22px] py-[13px] text-[13px] font-bold no-underline"
          :style="{ backgroundImage: WORDMARK_GRADIENT }"
        >
          ▸ back to home
        </a>
        <a
          href="https://grimicorn.dev"
          target="_blank"
          rel="noopener noreferrer"
          class="text-fg rounded-none border border-white/[0.16] bg-white/[0.02] px-[22px] py-[13px] text-[13px] font-medium no-underline"
        >
          meet the agent →
        </a>
      </div>

      <!-- terminal trace -->
      <div
        class="mx-auto max-w-[520px] overflow-hidden border border-white/[0.08] text-left text-[13px] leading-loose text-[#d4d4d8]"
        style="background: #08080a; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.4)"
      >
        <div
          class="flex items-center gap-[14px] border-b border-white/[0.07] bg-white/[0.015] px-[18px] py-3"
        >
          <span class="flex gap-2">
            <span class="bg-pink h-3 w-3 rounded-full" />
            <span class="bg-amber h-3 w-3 rounded-full" />
            <span class="bg-lime h-3 w-3 rounded-full" />
          </span>
          <span class="text-fg-subtle ml-[6px] truncate text-[12.5px]"
            >neon-pixels — zsh</span
          >
        </div>
        <div class="px-[18px] py-4 sm:px-6">
          <div>
            <span class="text-lime">neon</span
            ><span class="text-[#737b8a]">@</span
            ><span class="text-cyan">pixels</span>
            <span class="text-[#737b8a]"> ~ %</span> cat
            <span class="text-fg-muted">{{ displayPath }}</span>
          </div>
          <div class="text-[#cdcac4]">
            cat: <span class="text-fg-muted">{{ displayPath }}</span
            >:
            <span class="text-pink">{{ missingLine }}</span>
          </div>
          <div>
            <span class="text-lime">neon</span
            ><span class="text-[#737b8a]">@</span
            ><span class="text-cyan">pixels</span>
            <span class="text-[#737b8a]"> ~ %</span>
            <span
              class="animate-blink bg-lime ml-1 inline-block h-[15px] w-[9px] align-[-2px]"
            />
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
