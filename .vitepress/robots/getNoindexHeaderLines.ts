// Netlify can't scope a [[headers]] block in netlify.toml to a deploy
// context (see .vitepress/tests/netlify.test.ts), so the noindex header has
// to go into the build-time `_headers` file instead — this module only
// decides WHICH line to add; see .vitepress/csp/writeReportOnlyHeaders for
// where it's written and why it rides in that file's one `/*` block rather
// than a second block.
const NOINDEX_HEADER_LINE = "X-Robots-Tag: noindex";
// Netlify's build-time CONTEXT env var: "production" | "deploy-preview" |
// "branch-deploy" | "dev". Allowlisted rather than excluding "production" so
// an unrecognised future context value defaults to indexable, not hidden.
const NOINDEXED_DEPLOY_CONTEXTS = new Set(["deploy-preview", "branch-deploy"]);

export function getNoindexHeaderLines(context = process.env.CONTEXT) {
  if (!context || !NOINDEXED_DEPLOY_CONTEXTS.has(context)) {
    return [];
  }
  return [NOINDEX_HEADER_LINE];
}
