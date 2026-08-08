import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";

// Lints Vue snippets through the project's real eslint.config.js. These tests
// fail if the vuejs-accessibility ruleset is ever unwired from the config,
// which is the whole point: they guard the a11y guardrail itself, not just the
// current markup. A `.vue` path under the theme dir is required so the config's
// Vue overrides (and the a11y flat config's `files` globs) apply.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Anchored to the repo root, not process.cwd(): both ESLint config discovery
// and the `files` glob matching resolve against `cwd`, so pinning it keeps the
// test honest regardless of where the runner is invoked from. A cwd-relative
// path that resolved outside the repo would silently lint against no config and
// return zero messages, quietly passing the negative assertions.
const PROBE_FILE_PATH = path.join(
  REPO_ROOT,
  ".vitepress/theme/components/_a11y-probe.vue",
);
// A cwd-relative, forward-slash glob (not path.join): ESLint's matcher wants
// forward slashes on every platform and resolves relative patterns against the
// pinned cwd, so an absolute, back-slashed path would match nothing on Windows.
const COMPONENTS_GLOB = ".vitepress/theme/**/*.vue";
const A11Y_RULE_PREFIX = "vuejs-accessibility/";
// ESLint's numeric severity for "error"; the point of these rules is to block
// CI, so the tests assert this rather than merely that a rule reported.
const ERROR_SEVERITY = 2;

// errorOnUnmatchedPattern is off so the glob test reports its own assertion
// ("expected 0 to be greater than 0") if the components ever move, instead of
// dying inside ESLint with a NoFilesFoundError.
const eslint = new ESLint({ cwd: REPO_ROOT, errorOnUnmatchedPattern: false });

async function lintVue(source: string) {
  const results = await eslint.lintText(source, { filePath: PROBE_FILE_PATH });
  const messages = results.flatMap((result) => result.messages);
  const fatalMessage = messages.find((message) => message.fatal);
  if (fatalMessage) {
    throw new Error(`Probe source failed to parse: ${fatalMessage.message}`);
  }
  return messages;
}

function expectRuleError(
  messages: Awaited<ReturnType<typeof lintVue>>,
  ruleId: string,
) {
  const match = messages.find((message) => message.ruleId === ruleId);
  expect(match, `expected an error from ${ruleId}`).toBeDefined();
  expect(match?.severity).toBe(ERROR_SEVERITY);
}

describe("eslint accessibility ruleset", () => {
  it("flags an image without an alt attribute", async () => {
    const messages = await lintVue(
      `<template>\n  <img src="/x.png" />\n</template>\n`,
    );
    expectRuleError(messages, "vuejs-accessibility/alt-text");
  });

  it("flags a click handler on a non-interactive element with no keyboard listener", async () => {
    const messages = await lintVue(
      `<template>\n  <div @click="handle">go</div>\n</template>\n`,
    );
    expectRuleError(
      messages,
      "vuejs-accessibility/click-events-have-key-events",
    );
  });

  it("raises no accessibility errors on clean, semantic markup", async () => {
    const messages = await lintVue(
      `<template>\n  <img src="/x.png" alt="a descriptive label" />\n  <button type="button">go</button>\n</template>\n`,
    );
    const accessibilityRuleIds = messages
      .map((message) => message.ruleId)
      .filter((ruleId) => ruleId?.startsWith(A11Y_RULE_PREFIX));
    expect(accessibilityRuleIds).toEqual([]);
  });

  it("resolves the ruleset against the real theme components, not just a synthetic path", async () => {
    const results = await eslint.lintFiles(COMPONENTS_GLOB);
    // A hit here proves the config's `files` globs actually cover the real
    // component directory: a probe-only path could keep passing even if the
    // glob were narrowed to exclude where components truly live.
    expect(results.length).toBeGreaterThan(0);
  });
});
