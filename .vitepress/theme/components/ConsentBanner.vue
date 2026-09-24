<script setup lang="ts">
import { onMounted, ref } from "vue";
import { WORDMARK_GRADIENT } from "../brand";
import {
  CONSENT_CHOICES,
  setStoredConsentChoice,
  shouldLoadAnalytics,
  shouldPromptForConsent,
  type ConsentChoice,
} from "../analytics/analyticsConsent";
import {
  GA_MEASUREMENT_ID,
  loadGoogleAnalytics,
} from "../analytics/loadGoogleAnalytics";

// Rendered once from AppLayout, next to the skip link, so every route shares
// one banner instance instead of each view wiring its own. Starts hidden and
// only ever becomes visible from inside onMounted below — which, unlike a
// plain top-level check, Vue never calls during VitePress's SSG build, so
// this component needs no separate `import.meta.env.SSR` guard to avoid
// touching `navigator`/`localStorage` on the server.
const isVisible = ref(false);

onMounted(() => {
  if (shouldLoadAnalytics(navigator, localStorage)) {
    loadGoogleAnalytics(GA_MEASUREMENT_ID);
    return;
  }
  isVisible.value = shouldPromptForConsent(navigator, localStorage);
});

function recordChoice(choice: ConsentChoice) {
  setStoredConsentChoice(localStorage, choice);
  isVisible.value = false;
  if (choice === CONSENT_CHOICES.accepted) {
    loadGoogleAnalytics(GA_MEASUREMENT_ID);
  }
}
</script>

<template>
  <div
    v-if="isVisible"
    role="region"
    aria-label="Analytics consent"
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
</template>
