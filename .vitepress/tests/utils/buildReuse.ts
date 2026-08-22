// Single source of truth for the smoke-build reuse flag name, shared by the
// smoke suite (build-html.test.ts) that reads it and the deploy-command guard
// (netlify.test.ts) that asserts netlify.toml sets it. netlify.toml carries the
// same literal in TOML, so a rename must touch both this file and netlify.toml.
export const SMOKE_BUILD_REUSE_DIR_ENV = "SMOKE_BUILD_REUSE_DIR";
