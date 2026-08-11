import type { Theme } from "vitepress";
import AppLayout from "./AppLayout.vue";
// Self-hosted fonts bundled by Vite (weights match the former Google Fonts request:
// Archivo 400/600/800/900, JetBrains Mono 400/500/700). Each file carries its own
// @font-face with font-display: swap, so no third-party font origin is contacted.
import "@fontsource/archivo/400.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/800.css";
import "@fontsource/archivo/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./style.css";

export default {
  Layout: AppLayout,
  enhanceApp() {},
} satisfies Theme;
