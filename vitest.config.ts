import { fileURLToPath, URL } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import preset from "@neon-pixels/vitest-preset/vitepress";

const PRESET_E2E_EXCLUDE = "**/e2e/**";

// The preset excludes every `e2e` directory, which would also drop the unit
// tests in .vitepress/tests/e2e. The include glob below already keeps the
// Playwright specs in the root e2e/ directory out, so only this one entry is
// removed. mergeConfig concatenates exclude arrays, so it has to be replaced
// after the merge rather than overridden inside it.
function withoutPresetE2eExclude(exclude: string[] = []) {
  return exclude.filter((pattern) => pattern !== PRESET_E2E_EXCLUDE);
}

const merged = mergeConfig(
  preset,
  defineConfig({
    resolve: {
      alias: {
        "@components": fileURLToPath(
          new URL(".vitepress/theme/components", import.meta.url),
        ),
        "@theme": fileURLToPath(new URL(".vitepress/theme", import.meta.url)),
      },
    },
    test: {
      include: [".vitepress/tests/**/*.test.{js,ts}"],
    },
  }),
);

export default {
  ...merged,
  test: {
    ...merged.test,
    exclude: withoutPresetE2eExclude(merged.test?.exclude),
  },
};
