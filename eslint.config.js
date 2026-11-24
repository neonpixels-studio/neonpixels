import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import vitepress from "@neon-pixels/eslint-config/vitepress";

export default defineConfig(
  globalIgnores([
    ".vitepress/dist/**",
    ".vitepress/cache/**",
    "node_modules/**",
    "export/**",
  ]),
  vitepress,
  {
    // GitHub Actions loads these via require() from actions/github-script
    // (see .github/workflows/security.yml), so they're plain Node
    // CommonJS, not part of the Vite/TS toolchain the rest of the repo uses.
    files: [".github/scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      // require() is the only module system available to these CommonJS files.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
