import type { Theme } from "vitepress";
import AppLayout from "./AppLayout.vue";
// Self-hosted fonts bundled by Vite, trimmed to only the weights the UI renders and
// (since the site is lang=en-US) the latin subset only. Archivo is used solely via
// .font-display + font-black (weight 900); JetBrains Mono is the body/mono face at
// weight 400 (default), 500 (font-medium), and 700 (font-bold). Each file carries its
// own @font-face with font-display: swap, so no third-party font origin is contacted.
// Any non-latin code point falls back to the system stack — e.g. the hardcoded ∞ in the
// about stat row and a visitor-controlled 404 path echo. An accepted cosmetic trade for
// the smaller bundle (these glyphs already fell back before the trim; Archivo/JetBrains
// bundle no ∞ glyph in any subset).
import "@fontsource/archivo/latin-900.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./style.css";

export default {
  Layout: AppLayout,
  enhanceApp() {},
} satisfies Theme;
