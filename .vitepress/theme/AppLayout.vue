<script setup lang="ts">
import { useData } from "vitepress";
import NeonPixelsPage from "./components/NeonPixelsPage.vue";
import NotFound from "./components/NotFound.vue";
import { MAIN_CONTENT_ID } from "./a11y";

const { page } = useData();

// Hoisted here so the home route and the 404 route share one skip-link
// implementation instead of each shipping (or forgetting) its own.
//
// VitePress's router intercepts same-page hash links (capture phase, preventing
// the default) and only scrolls — it never moves focus. So a bare
// href="#main-content" would scroll without focusing <main>, and the next Tab
// would fall back into the header nav, defeating the bypass. The <main> is
// rendered by the child view below, not this layout, so resolve it by id and
// move focus ourselves; focus() also scrolls it into view.
function skipToContent(event: MouseEvent) {
  // preventDefault is belt-and-suspenders: VitePress already suppresses the hash
  // nav at capture phase, but this also covers the non-router test environment.
  event.preventDefault();
  const landmark = document.getElementById(MAIN_CONTENT_ID);
  // Fail loud rather than no-op silently: if a view ever forgets to expose the
  // shared landmark id, surface it in the console instead of a dead bypass.
  if (!landmark) {
    console.warn(`skip link: no #${MAIN_CONTENT_ID} landmark on this route`);
    return;
  }
  landmark.focus();
}
</script>

<template>
  <!-- skip link: first focusable element, visually hidden until focused. Shared
       across both views so bypass-blocks holds on / and on 404 alike. -->
  <a :href="`#${MAIN_CONTENT_ID}`" class="skip-link" @click="skipToContent">
    Skip to content
  </a>
  <NotFound v-if="page.isNotFound" />
  <NeonPixelsPage v-else />
</template>

<style scoped>
/* Skip-to-content link: kept in the DOM and tab order but slid out of sight
   above the viewport, then dropped into the top-left corner on keyboard focus.
   z-index clears the sticky header (z-30). The global :focus-visible ring in
   style.css lands on it like any other anchor, so no focus styles are needed
   here. */
.skip-link {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 50;
  margin: 12px;
  padding: 10px 16px;
  transform: translateY(-160%);
  transition: transform 0.2s ease;
  background: var(--color-panel);
  /* lime edge so the revealed chip reads as a distinct landing target where it
     overlays the header, not bare text (panel/border are near-invisible on bg) */
  border: 1px solid var(--color-lime);
  color: var(--color-fg);
  font-size: 12.5px;
}
.skip-link:focus {
  transform: translateY(0);
}
@media (prefers-reduced-motion: reduce) {
  .skip-link {
    transition: none;
  }
}
</style>
