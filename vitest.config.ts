import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@components": fileURLToPath(
        new URL(".vitepress/theme/components", import.meta.url),
      ),
      "@theme": fileURLToPath(new URL(".vitepress/theme", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    env: { TZ: "UTC" },
    include: [".vitepress/tests/**/*.test.{js,ts}"],
  },
});
