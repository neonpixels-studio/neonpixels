<script setup lang="ts">
import { onMounted, ref } from "vue";
import { WORDMARK_GRADIENT } from "../brand";
import {
  CONSENT_CHOICES,
  getConsentStorage,
  getStoredConsentChoice,
  setStoredConsentChoice,
  shouldLoadAnalytics,
  shouldPromptForConsent,
  trackingSignalPresent,
  type ConsentChoice,
  type ConsentStorage,
} from "../analytics/analyticsConsent";
import {
  GA_MEASUREMENT_ID,
  disableGoogleAnalytics,
  loadGoogleAnalytics,
} from "../analytics/loadGoogleAnalytics";

// Rendered once from AppLayout, next to the skip link, so every route shares
// one banner instance instead of each view wiring its own. Starts hidden and
// only ever becomes visible from inside onMounted below — which, unlike a
// plain top-level check, Vue never calls during VitePress's SSG build, so
// this component needs no separate `import.meta.env.SSR` guard to avoid
// touching `navigator`/`localStorage` on the server.
const isVisible = ref(false);

// A small persistent control that lets a visitor re-open the banner and
// change an already-recorded choice — consent withdrawal has to be at least
// as easy as giving it. Only offered when there's an actual choice to change:
// never while a DNT/GPC signal is present (the browser already answered the
// question; nothing here would override it) and never before any choice has
// been recorded (the main banner is already offering that decision).
const canManageChoice = ref(false);

// Assigned inside onMounted, never at setup() top level: getConsentStorage()
// touches `window.localStorage`, and VitePress's SSG build runs this
// component's setup() on the server, where no `window` exists at all. Safe to
// read from recordChoice()/reopenBanner() below without an existence check —
// both are only reachable via a click on a rendered button, and nothing here
// renders until after onMounted has run.
let consentStorage: ConsentStorage;

// Whether gtag.js has actually loaded this session, so Decline can tell
// "revoke an already-active choice" (needs disableGoogleAnalytics — a loaded
// script can't be un-run) apart from "decline for the first time" (nothing
// loaded yet).
let analyticsIsActive = false;

onMounted(() => {
  consentStorage = getConsentStorage();
  if (shouldLoadAnalytics(navigator, consentStorage)) {
    loadGoogleAnalytics(GA_MEASUREMENT_ID);
    analyticsIsActive = true;
    canManageChoice.value = true;
    return;
  }
  isVisible.value = shouldPromptForConsent(navigator, consentStorage);
  canManageChoice.value =
    !isVisible.value &&
    !trackingSignalPresent(navigator) &&
    getStoredConsentChoice(consentStorage) !== null;
});

function recordChoice(choice: ConsentChoice) {
  setStoredConsentChoice(consentStorage, choice);
  isVisible.value = false;
  canManageChoice.value = !trackingSignalPresent(navigator);

  if (choice === CONSENT_CHOICES.declined) {
    if (analyticsIsActive) {
      disableGoogleAnalytics(GA_MEASUREMENT_ID);
      analyticsIsActive = false;
    }
    return;
  }

  // Defense in depth: Accept is only ever reachable through this banner, and
  // the banner is never shown while a DNT/GPC signal is present — but this
  // must never honor an Accept click if that ever stops being true.
  if (trackingSignalPresent(navigator)) {
    return;
  }
  loadGoogleAnalytics(GA_MEASUREMENT_ID);
  analyticsIsActive = true;
}

function reopenBanner() {
  isVisible.value = true;
  canManageChoice.value = false;
}
</script>

<template>
  <div
    v-if="isVisible"
    role="region"
    aria-label="Analytics consent"
    aria-live="polite"
    class="bg-panel border-border text-fg fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-between gap-4 border-t px-5 py-4 font-mono sm:px-8"
  >
    <p class="text-fg-muted m-0 max-w-[560px] text-[13px] leading-[1.6]">
      This site uses Google Analytics to see which pages get read. Nothing loads
      until you say yes, and your choice only lives in this browser.
    </p>
    <div class="flex gap-3">
      <button
        type="button"
        class="text-bg animate-sweep rounded-none px-4 py-2 text-[13px] font-bold"
        :style="{ backgroundImage: WORDMARK_GRADIENT }"
        @click="recordChoice(CONSENT_CHOICES.accepted)"
      >
        Accept
      </button>
      <button
        type="button"
        class="text-fg rounded-none border border-white/[0.16] bg-white/[0.02] px-4 py-2 text-[13px] font-medium"
        @click="recordChoice(CONSENT_CHOICES.declined)"
      >
        Decline
      </button>
    </div>
  </div>
  <button
    v-else-if="canManageChoice"
    type="button"
    class="text-fg-subtle border-border bg-panel fixed bottom-3 left-3 z-40 rounded-none border px-3 py-1.5 font-mono text-[11px]"
    @click="reopenBanner"
  >
    Analytics choice
  </button>
</template>
