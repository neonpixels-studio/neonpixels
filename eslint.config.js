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
    // Also matches .d.cts (e.g. notify-audit-failure.d.cts): it's TypeScript
    // syntax (export type, declare), so it needs the TS parser too, even
    // though its filename doesn't end in plain .ts.
    files: ["**/*.ts", "**/*.d.cts"],
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
    files: [".github/scripts/**/*.cjs"],
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
      // eslint-plugin-vue's recommended preset only sets this to "warn",
      // and `npm run lint` doesn't pass --max-warnings, so a bare warning
      // wouldn't fail CI. Pin it to "error" so it actually blocks: this
      // project renders no untrusted HTML, so any v-html usage should be
      // caught, not merely logged. If a genuine need for v-html ever comes
      // up, scope an `eslint-disable-next-line vue/no-v-html` at that call
      // site with a comment justifying the trusted source, rather than
      // relaxing this back to "warn" or "off".
      "vue/no-v-html": "error",
    },
  },
  {
    // Ambient declaration files carry only type signatures, no runtime
    // logic. Base ESLint (no TS-aware plugin is configured here) can't tell
    // a `declare function` parameter name (documentation, not usage) from a
    // real unused variable, and doesn't understand the "function + namespace"
    // declaration-merging pattern used below to attach static properties
    // (AUDIT_FAILURE_LABEL, ISSUE_TITLE) to a CommonJS module's default
    // export — it reads that as a duplicate declaration. Type-checking
    // (vue-tsc) is the right tool for this file, not ESLint. Scoped to this
    // one declaration file (rather than a blanket `**/*.d.ts`/`**/*.d.cts`
    // ignore) so a future declaration file with a genuine mistake still gets
    // caught.
    files: [".github/scripts/notify-audit-failure.d.cts"],
    rules: {
      "no-unused-vars": "off",
      "no-redeclare": "off",
    },
  },
  prettier,
  {
    ignores: [
      ".vitepress/dist/**",
      ".vitepress/cache/**",
      "node_modules/**",
      "export/**",
    ],
  },
];
