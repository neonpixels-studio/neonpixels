<script setup lang="ts">
import { computed } from "vue";
import type { Project } from "../data/projects";
import { hexToRgba } from "../utils/color";

// The heading glow and the filled-CTA shadows are the accent color at fixed
// alphas; the aurora alpha lives per-project in the section data.
const HEADING_GLOW_ALPHA = 0.6;
const CTA_FILL_SHADOW_ALPHA = 0.35;
const CTA_FILL_HOVER_ALPHA = 0.6;

// Written as literal Tailwind class strings (not interpolated) so the JIT
// scanner still emits them. `text-bg` is the page background ink (#08080a).
const BADGE_BASE = "font-display px-2 text-[12px] font-black tracking-[0.08em]";
const BADGE_FILL = "py-[3px] text-bg";
const BADGE_OUTLINE = "py-[2px] border";
const CTA_BASE = "self-start px-5 py-3 text-[13px] font-bold";
const CTA_FILL = "cta-fill text-bg";
const CTA_OUTLINE = "cta-outline border";

const props = defineProps<{ project: Project }>();

const isFilled = computed(() => props.project.variant === "fill");

const badgeClass = computed(() => {
  if (isFilled.value) {
    return `${BADGE_BASE} ${BADGE_FILL} ${props.project.accent.bg}`;
  }
  return `${BADGE_BASE} ${BADGE_OUTLINE} ${props.project.accent.text} ${props.project.accent.border}`;
});

const ctaClass = computed(() => {
  if (isFilled.value) {
    return `${CTA_FILL} ${CTA_BASE} ${props.project.accent.bg}`;
  }
  return `${CTA_OUTLINE} ${CTA_BASE} ${props.project.accent.text} ${props.project.accent.border}`;
});

const ctaStyle = computed(() => {
  if (isFilled.value) {
    return {
      boxShadow: `0 0 26px ${hexToRgba(props.project.color, CTA_FILL_SHADOW_ALPHA)}`,
      "--accent-glow": hexToRgba(props.project.color, CTA_FILL_HOVER_ALPHA),
    };
  }
  return { "--accent": props.project.color };
});

const tldClass = computed(() => {
  if (props.project.flickerTld) {
    return `${props.project.accent.text} animate-flicker`;
  }
  return props.project.accent.text;
});

const headingGlowStyle = computed(() => ({
  textShadow: `0 0 18px ${hexToRgba(props.project.color, HEADING_GLOW_ALPHA)}`,
}));
</script>

<template>
  <div class="flex flex-col gap-5">
    <div class="flex items-center gap-3">
      <span :class="badgeClass">{{ project.status }}</span>
      <span class="text-fg-dim text-[11px] tracking-[0.2em] uppercase"
        >{{ project.order }} — {{ project.category }}</span
      >
    </div>
    <h3
      class="font-display m-0 font-black tracking-[-0.03em] text-[#f2f2f4]"
      style="font-size: clamp(38px, 5vw, 66px); line-height: 0.92"
    >
      {{ project.name
      }}<span :class="tldClass" :style="headingGlowStyle">{{
        project.tld
      }}</span>
    </h3>
    <p
      class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-[#a8a8b3]"
      style="text-wrap: pretty"
    >
      {{ project.description }}
    </p>
    <a
      :href="project.url"
      target="_blank"
      rel="noopener noreferrer"
      :class="ctaClass"
      :style="ctaStyle"
      >visit {{ project.name }}{{ project.tld }} →</a
    >
  </div>
</template>

<style scoped>
/* Scoped to this component now that the CTA markup lives here. Both hover
   accents come from custom properties ctaStyle sets per project (--accent-glow
   for fill, --accent for outline), so the hover matches any accent color. */
.cta-fill {
  transition: box-shadow 0.2s ease;
}
.cta-fill:hover {
  box-shadow: 0 0 42px var(--accent-glow);
}

.cta-outline {
  transition:
    background 0.2s ease,
    color 0.2s ease;
}
.cta-outline:hover {
  background: var(--accent);
  color: var(--color-bg);
}

/* Keyboard focus for the project CTAs: same WCAG 2.4.7 concern as the hero
   pills and footer links, but scoped here since the CTA markup lives in this
   component. The outline-offset lifts the ring onto the dark page so it reads
   even on a fill CTA whose background is the accent color. The outline variant
   already exposes --accent; the fill variant does not, so both fall back to the
   lime brand token. */
.cta-fill:focus-visible,
.cta-outline:focus-visible {
  outline: 2px solid var(--accent, var(--color-lime));
  outline-offset: 2px;
}
</style>
