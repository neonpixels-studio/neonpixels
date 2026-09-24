<script setup lang="ts">
import { nextTick, onMounted, ref, type Ref } from "vue";
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
  clearGoogleAnalyticsCookies,
  disableGoogleAnalytics,
  enableGoogleAnalytics,
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

const acceptButtonRef = ref<HTMLButtonElement | null>(null);
const manageButtonRef = ref<HTMLButtonElement | null>(null);

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

// The Accept/Decline pair and the manage-choice control take turns occupying
// the same spot in the layout (v-if/v-else-if), so clicking one always
// unmounts whatever button was just focused — without this, focus would fall
// back to <body> on every transition and a keyboard user would have to tab
// in from the top of the page to reach whichever control just appeared.
async function focusAfterRender(targetRef: Ref<HTMLButtonElement | null>) {
  await nextTick();
  targetRef.value?.focus();
}

// Revokes a choice that already loaded gtag.js this session: the kill-switch
// (a loaded script can't be un-run in-page) plus clearing GA4's own identifier
// cookies, so a later re-accept starts a fresh client id instead of resuming
// the one from before the visitor withdrew consent.
function revokeActiveAnalytics() {
  if (!analyticsIsActive) {
    return;
  }
  disableGoogleAnalytics(GA_MEASUREMENT_ID);
  clearGoogleAnalyticsCookies();
  analyticsIsActive = false;
}

function recordChoice(choice: ConsentChoice) {
  setStoredConsentChoice(consentStorage, choice);
  isVisible.value = false;
  canManageChoice.value = !trackingSignalPresent(navigator);
  void focusAfterRender(manageButtonRef);

  if (choice === CONSENT_CHOICES.declined) {
    revokeActiveAnalytics();
    return;
  }

  // Defense in depth: Accept is only ever reachable through this banner, and
  // the banner is never shown while a DNT/GPC signal is present — but this
  // must never honor an Accept click if that ever stops being true.
  if (trackingSignalPresent(navigator)) {
    return;
  }
  // Clears any kill-switch flag a prior Decline left set this session —
  // loadGoogleAnalytics's load-once guard means a second call would
  // otherwise no-op while that flag was still in effect (see
  // enableGoogleAnalytics's own comment).
  enableGoogleAnalytics(GA_MEASUREMENT_ID);
  loadGoogleAnalytics(GA_MEASUREMENT_ID);
  analyticsIsActive = true;
}

function reopenBanner() {
  isVisible.value = true;
  canManageChoice.value = false;
  void focusAfterRender(acceptButtonRef);
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
        ref="acceptButtonRef"
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
    ref="manageButtonRef"
    type="button"
    class="text-fg-subtle border-border bg-panel fixed bottom-3 left-3 z-40 rounded-none border px-3 py-1.5 font-mono text-[11px]"
    @click="reopenBanner"
  >
    Analytics choice
  </button>
</template>
