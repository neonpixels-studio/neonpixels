# Neon Pixels

Landing page for [neonpixels.io](https://neonpixels.io) — a very small studio and one very caffeinated agent, shipping the tools we kept wishing existed.

Built with [VitePress](https://vitepress.dev) and a fully custom [Tailwind CSS v4](https://tailwindcss.com) theme (no default VitePress chrome).

## Requirements

- Node.js — the version pinned in [`.nvmrc`](.nvmrc) (`nvm use`)

## Getting started

```bash
npm install
npm run dev
```

The site is a single custom-themed page. The theme lives in `.vitepress/theme`:

- `AppLayout.vue` — swaps between the landing page and the 404 view
- `components/NeonPixelsPage.vue` — the landing page
- `components/NotFound.vue` — the 404 view
- `style.css` — Tailwind entry, theme tokens, keyframes and animation utilities

## Scripts

| Script              | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the local dev server                    |
| `npm run build`     | Build the static site to `.vitepress/dist`    |
| `npm run preview`   | Preview the production build locally          |
| `npm test`          | Run the test suite in watch mode              |
| `npm run test:ci`   | Run the test suite once                       |
| `npm run typecheck` | Type-check with `vue-tsc`                     |
| `npm run lint`      | Check formatting (Prettier) and lint (ESLint) |
| `npm run lint:fix`  | Auto-fix formatting and lint issues           |
| `npm run audit`     | Audit production dependencies                 |

## Testing

Tests use [Vitest](https://vitest.dev) with `happy-dom` and `@vue/test-utils`. They
cover the components, the SEO/social metadata in `config.ts` (Open Graph and Twitter
cards, favicons resolve to real files), the Netlify security headers, and the ESLint
accessibility ruleset.

## Deployment

Deploys to [Netlify](https://www.netlify.com). See [`netlify.toml`](netlify.toml) for
the build command, publish directory and security headers. The build runs the test
suite before building, so a failing test blocks the deploy.

### CSP violation collector

The enforcing `Content-Security-Policy` in `netlify.toml` still allows
`script-src 'unsafe-inline'`. The build (`buildEnd` in `.vitepress/config.ts`)
also publishes a stricter `Content-Security-Policy-Report-Only` header via a
generated `_headers` file that hashes VitePress's inline scripts. That header is
wired to a collector — a `Reporting-Endpoints` header plus `report-to` /
`report-uri` directives point violations at the `/csp-report` Netlify Function
([`netlify/functions/csp-report.ts`](netlify/functions/csp-report.ts)), which
records them to the function logs **and** persists each accepted,
same-origin violation to [Netlify Blobs](https://docs.netlify.com/blobs/overview/)
(store name `csp-reports`, one blob per violation, key
`<receivedAt ISO timestamp, colons/periods replaced with dashes>-<uuid>.json`)
so the rollout signal is queryable instead of grep-only. A violation whose
`document-uri`/`documentURL` doesn't match this site's own origin (Netlify's
injected `URL`/`DEPLOY_PRIME_URL`, plus the request's own origin — so
production, branch deploys, previews and `netlify dev` all persist) is still
logged to the console but skipped for
persistence, with a `csp-report-not-persisted` marker so the skip itself is
visible rather than reading as "no violations". This is a noise filter, not an
anti-forgery control — `documentUrl` is attacker-controlled request-body
content on this public, unauthenticated endpoint, so it only screens out
misconfigured integrations and reports sent to the wrong deploy, not a forger
who reads the source. The Blobs write is isolated in
[`netlify/functions/lib/cspReportStore.ts`](netlify/functions/lib/cspReportStore.ts)
behind a minimal `BlobWriter` interface, so the write path is unit-tested with a
fake writer rather than the real Blobs client. Netlify auto-configures Blobs for
Functions (siteID/token injected at runtime) both in production and under
`netlify dev`, so **no new environment variables are required**; if the Blobs
context is ever missing (e.g. a bare `netlify functions:invoke` without a linked
site) or the write is slow, the write is skipped/timed out (3s) and a
`csp-report-persist-failed` marker is logged — the console log and the 204/4xx
response are unaffected either way, since browsers treat this endpoint as a
fire-and-forget beacon and won't retry a timed-out request. The
parsing/validation is isolated in
[`.vitepress/csp/cspReportCollector.ts`](.vitepress/csp/cspReportCollector.ts)
so it is unit-testable without the Netlify runtime.

Since `/csp-report` is public and unauthenticated, sustained abuse could grow
the `csp-reports` store without bound. A daily Netlify scheduled Function
([`netlify/functions/csp-report-prune.ts`](netlify/functions/csp-report-prune.ts))
prunes it: blobs older than `CSP_REPORT_RETENTION_DAYS` (default 30) are always
deleted, and whatever remains is then trimmed to `CSP_REPORT_MAX_BLOBS`
(default 5000), oldest first, so a flood landing entirely inside the retention
window is still capped rather than only aged out on the next cutoff. Both are
optional site environment variables (set via the Netlify dashboard or CLI, not
a `.env` file — this repo has none) for tuning the window/cap without a code
change; neither is required for pruning to run. The prune strategy is isolated
in
[`netlify/functions/lib/cspReportPruner.ts`](netlify/functions/lib/cspReportPruner.ts)
behind a minimal `list`/`delete` seam (mirroring `BlobWriter` above), so it is
unit-tested with a fake client rather than the real Blobs store. A failed
prune run logs a `csp-report-prune-failed` marker and tries again on the next
scheduled run; it never blocks or slows the `/csp-report` endpoint itself.
Once the logs show no
`script-src` violations **and no `csp-report-rejected` or `csp-report-unparsed`
entries** over the observation window, `'unsafe-inline'` can be dropped from the
enforcing `script-src` (see the `@todo` in `netlify.toml`). The two markers
matter: a request rejected for an unmodelled content type or an unrecognized
body shape would otherwise read as "no violations", so a clean run must show
neither.

## Git hooks

Managed with [Husky](https://typicode.github.io/husky):

- **pre-commit** — [gitleaks](https://github.com/gitleaks/gitleaks) secret scan
- **pre-push** — lint, typecheck and tests
- **post-merge** — reinstalls dependencies when the lockfile changes

Install gitleaks locally (`brew install gitleaks`) so the pre-commit hook can run.
