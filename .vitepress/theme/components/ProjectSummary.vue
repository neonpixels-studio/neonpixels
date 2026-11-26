<script setup lang="ts">
import { computed, onMounted } from "vue";
import type { Project } from "../data/projects";
import { projectStyleClass } from "../generatedStyles";
import type { Consent } from "@neon-pixels/consent";
import {
  createSiteConsent,
  getConsentStorage,
} from "../analytics/analyticsConsent";
import { trackGoogleAnalyticsEvent } from "../analytics/loadGoogleAnalytics";

// GA4 event name for a project CTA click, tracked so traffic driven to each
// project's own domain (the site's actual conversion goal) is visible in GA4
// instead of vanishing the moment a visitor leaves neonpixels.dev. Deliberate
// overlap: GA4's built-in "Outbound clicks" Enhanced Measurement (on by
// default for web streams) already logs these as a generic `click` event —
// this custom event additionally carries `project_name` (so each project is
// its own row, not one lumped "outbound clicks" total) and, unlike the
// built-in one, also fires on middle-click (see handleCtaAuxClick below).
const OUTBOUND_CLICK_EVENT = "outbound_click";

// MouseEvent.button value for the middle mouse button — a common way to open
// a link in a new tab, which the browser reports as `auxclick`, not `click`.
const MIDDLE_MOUSE_BUTTON = 1;

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
    const fillClass = projectStyleClass(props.project.id, "cta-fill");
    return `${CTA_FILL} ${CTA_BASE} ${props.project.accent.bg} ${fillClass}`;
  }
  const accentClass = projectStyleClass(props.project.id, "accent");
  return `${CTA_OUTLINE} ${CTA_BASE} ${props.project.accent.text} ${props.project.accent.border} ${accentClass}`;
});

const tldClass = computed(() => {
  const glowClass = projectStyleClass(props.project.id, "heading-glow");
  if (props.project.flickerTld) {
    return `${props.project.accent.text} ${glowClass} animate-flicker`;
  }
  return `${props.project.accent.text} ${glowClass}`;
});

// Resolved once on mount (same pattern as ConsentBanner.vue's own
// `consent`), not read fresh inside trackOutboundClick — getConsentStorage()
// probes localStorage with a set/remove round-trip, and this CTA can be
// clicked far more often than the banner's Accept/Decline buttons ever are.
let consent: Consent;

onMounted(() => {
  consent = createSiteConsent(getConsentStorage());
});

// Gated the same way page tracking already is (ConsentBanner.vue): only ever
// fires once the visitor has actively accepted analytics, with no DNT/GPC
// signal overriding that. Never blocks or delays the link's own navigation —
// trackGoogleAnalyticsEvent only ever pushes onto an in-memory array. Bound
// directly to `@click` (left-click, and Ctrl/Cmd+click, which still fires
// `click`); handleCtaAuxClick below covers the one case this doesn't.
function trackOutboundClick() {
  if (consent.status !== "granted") {
    return;
  }
  trackGoogleAnalyticsEvent(OUTBOUND_CLICK_EVENT, {
    project_name: props.project.name,
    destination_url: props.project.url,
  });
}

// Middle-click is a common way to open a link in a new tab, but the browser
// reports it as `auxclick`, not `click` — without this, that path would leave
// a real conversion silently untracked.
function handleCtaAuxClick(event: MouseEvent) {
  if (event.button !== MIDDLE_MOUSE_BUTTON) {
    return;
  }
  trackOutboundClick();
}
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
      class="font-display m-0 text-[clamp(38px,5vw,66px)] leading-[0.92] font-black tracking-[-0.03em] text-[#f2f2f4]"
    >
      {{ project.name }}<span :class="tldClass">{{ project.tld }}</span>
    </h3>
    <p
      class="m-0 max-w-[460px] text-[15px] leading-[1.75] text-pretty text-[#a8a8b3]"
    >
      {{ project.description }}
    </p>
    <a
      :href="project.url"
      target="_blank"
      rel="noopener noreferrer"
      :class="ctaClass"
      @click="trackOutboundClick"
      @auxclick="handleCtaAuxClick"
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
</style>
