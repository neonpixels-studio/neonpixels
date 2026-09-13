import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import pluginVueA11y from "eslint-plugin-vuejs-accessibility";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  ...pluginVueA11y.configs["flat/recommended"],
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tsParser },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // GitHub Actions loads these via require() from actions/github-script
    // (see .github/workflows/security.yml), so they're plain Node
    // CommonJS, not part of the Vite/TS toolchain the rest of the repo uses.
    files: [".github/scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "vue/no-v-html": "off",
    },
  },
  prettier,
  {
    // Ambient declaration files carry only type signatures, no runtime
    // logic — base ESLint's no-unused-vars can't tell a `declare function`
    // parameter name (there for documentation, not usage) from a real
    // unused variable, so type-checking (vue-tsc) is the right tool for
    // these, not ESLint.
    ignores: [
      ".vitepress/dist/**",
      ".vitepress/cache/**",
      "node_modules/**",
      "export/**",
      "**/*.d.ts",
    ],
  },
];
