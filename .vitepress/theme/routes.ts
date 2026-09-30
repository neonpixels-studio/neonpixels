// Single source of truth for the privacy policy route, shared by AppLayout
// (which matches on VitePress's page.relativePath to pick the right view)
// and ConsentBanner (which links to it), so the two can't drift apart the
// way a hand-typed path in each file could.

// Matches page.relativePath for privacy.md (the on-disk source file
// AppLayout branches on).
export const PRIVACY_POLICY_RELATIVE_PATH = "privacy.md";

// The clean, extensionless URL Netlify rewrites to privacy.html (see the
// redirect in netlify.toml) - what any link to the page should use.
export const PRIVACY_POLICY_URL = "/privacy";
