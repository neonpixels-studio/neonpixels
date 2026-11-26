<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { PROJECTS } from "../data/projects";

const NAV_LINKS = [
  { href: "#projects", label: "projects" },
  { href: "#about", label: "about" },
  { href: "#contact", label: "contact" },
];

const MOBILE_MENU_ID = "mobile-menu";
// Mirrors Tailwind's `md` breakpoint, where the desktop nav takes over. Kept in
// sync with the md: utilities below so an open mobile panel can't linger on a
// viewport that no longer shows its toggle.
const DESKTOP_MEDIA_QUERY = "(min-width: 48rem)";
const ESCAPE_KEY = "Escape";

const isMenuOpen = ref(false);
const menuToggle = useTemplateRef<HTMLButtonElement>("menuToggle");
let desktopQuery: MediaQueryList | undefined;

function toggleMenu() {
  isMenuOpen.value = !isMenuOpen.value;
}

function closeMenu() {
  isMenuOpen.value = false;
}

function closeMenuOnEscape(event: KeyboardEvent) {
  if (event.key !== ESCAPE_KEY || !isMenuOpen.value) {
    return;
  }
  closeMenu();
  menuToggle.value?.focus();
}

function closeMenuOnDesktop(event: MediaQueryListEvent) {
  if (!event.matches) {
    return;
  }
  closeMenu();
}

onMounted(() => {
  desktopQuery = window.matchMedia?.(DESKTOP_MEDIA_QUERY);
  desktopQuery?.addEventListener("change", closeMenuOnDesktop);
  document.addEventListener("keydown", closeMenuOnEscape);
});

onBeforeUnmount(() => {
  desktopQuery?.removeEventListener("change", closeMenuOnDesktop);
  document.removeEventListener("keydown", closeMenuOnEscape);
});
</script>

<template>
  <nav class="text-fg-subtle flex items-center gap-[26px] text-[12.5px]">
    <a
      v-for="link in NAV_LINKS"
      :key="link.href"
      :href="link.href"
      class="nav-link text-fg-subtle hidden md:inline"
      >{{ link.label }}</a
    >
    <span class="text-lime hidden items-center gap-[7px] md:flex">
      <span
        class="bg-lime animate-pulse-dot status-dot nav-dot-glow h-[7px] w-[7px] rounded-full"
      />{{ PROJECTS.length }} projects
    </span>

    <button
      ref="menuToggle"
      type="button"
      class="nav-link menu-toggle text-fg-subtle border-border border px-3 py-[6px] md:hidden"
      :aria-expanded="isMenuOpen"
      :aria-controls="MOBILE_MENU_ID"
      @click="toggleMenu"
    >
      {{ isMenuOpen ? "close" : "menu" }}
    </button>

    <div
      v-if="isMenuOpen"
      :id="MOBILE_MENU_ID"
      class="border-border bg-bg absolute top-full right-0 left-0 border-b px-10 py-4 md:hidden"
    >
      <ul class="m-0 flex list-none flex-col p-0">
        <li v-for="link in NAV_LINKS" :key="link.href">
          <a
            :href="link.href"
            class="nav-link text-fg-subtle block py-3 text-[14px]"
            @click="closeMenu"
            >{{ link.label }}</a
          >
        </li>
      </ul>
      <span class="text-lime flex items-center gap-[7px] pt-3">
        <span
          class="bg-lime animate-pulse-dot status-dot nav-dot-glow h-[7px] w-[7px] rounded-full"
        />{{ PROJECTS.length }} projects
      </span>
    </div>
  </nav>
</template>

<style scoped>
.nav-link {
  transition: color 0.2s ease;
}
.nav-link:hover {
  color: #e8e8ea;
}
.menu-toggle {
  background: transparent;
  font: inherit;
  cursor: pointer;
}
</style>
