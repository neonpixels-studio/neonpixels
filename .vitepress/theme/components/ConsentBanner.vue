<script setup lang="ts">
import { nextTick, onMounted, ref, type Ref } from "vue";
import {
  loadGoogleAnalytics,
  type Consent,
  type ConsentService,
  type ConsentStorage,
} from "@neon-pixels/consent";
import { GA_MEASUREMENT_ID } from "../analytics/loadGoogleAnalytics";
import {
  LEGACY_CONSENT_STORAGE_KEY,
  MANAGE_CHOICE_LABEL,
  createSiteConsent,
  getConsentStorage,
  hasStoredGrant,
} from "../analytics/analyticsConsent";
import { PRIVACY_POLICY_URL } from "../routes";

const SERVICE_LABELS: Record<ConsentService, string> = {
  analytics: "Google Analytics",
  sessionReplay: "session replay",
};

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

// Assigned inside onMounted, never at setup() top level: createSiteConsent()
// reads `navigator` and `window.localStorage`, and VitePress's SSG build runs
// this component's setup() on the server, where neither exists. Safe to read
// from recordChoice()/reopenBanner() below without an existence check: both
// are only reachable via a click on a rendered button, and nothing here
// renders until after onMounted has run.
let consent: Consent;

// What the banner text names: only the services the consent object was
// configured with.
const serviceNames = ref("");

function loadAnalytics() {
  loadGoogleAnalytics(GA_MEASUREMENT_ID, { document, window });
}

// Re-reads the package's state, which always reflects storage and the
// privacy signals as they are right now.
function syncControls() {
  isVisible.value = consent.shouldPrompt;
  canManageChoice.value =
    consent.status === "granted" || consent.status === "denied";
}

// An earlier grant must not survive a browser privacy signal: deny()
// switches analytics off and clears the GA cookies. A visitor with no grant is
// left alone so no choice is invented for them.
function revokeEarlierGrant(storage: ConsentStorage) {
  if (!hasStoredGrant(storage)) {
    return;
  }
  consent.deny();
  storage.removeItem(LEGACY_CONSENT_STORAGE_KEY);
}

onMounted(() => {
  const storage = getConsentStorage();
  consent = createSiteConsent(storage);
  serviceNames.value = consent.services
    .map((service) => SERVICE_LABELS[service])
    .join(" and ");

  if (consent.status === "signal") {
    revokeEarlierGrant(storage);
    return;
  }
  if (consent.status === "granted") {
    loadAnalytics();
  }
  syncControls();
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

function accept() {
  consent.grant();
  // grant() does nothing while a privacy signal is present. Gate on that
  // rather than on the stored grant, so a failed write still loads analytics
  // for this page, as a blocked store does.
  if (consent.status !== "signal") {
    loadAnalytics();
  }
  afterChoice();
}

function decline() {
  consent.deny();
  afterChoice();
}

function afterChoice() {
  // Close the banner and offer the manage control even if storage refused
  // the write, so a click always has a visible effect; the choice then just
  // does not survive a reload.
  isVisible.value = false;
  canManageChoice.value = consent.status !== "signal";
  void focusAfterRender(manageButtonRef);
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
      This site uses {{ serviceNames }} to see which pages get read. Nothing
      loads until you say yes, and your choice only lives in this browser.
      <a
        :href="PRIVACY_POLICY_URL"
        class="text-fg-subtle hover:text-fg underline transition-colors"
      >
        Privacy policy
      </a>
    </p>
    <div class="flex gap-3">
      <button
        ref="acceptButtonRef"
        type="button"
        class="text-bg animate-sweep wordmark-gradient rounded-none px-4 py-2 text-[13px] font-bold"
        @click="accept"
      >
        Accept
      </button>
      <button
        type="button"
        class="text-fg rounded-none border border-white/[0.16] bg-white/[0.02] px-4 py-2 text-[13px] font-medium"
        @click="decline"
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
    {{ MANAGE_CHOICE_LABEL }}
  </button>
</template>
