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
records them to the function logs. The parsing/validation is isolated in
[`.vitepress/csp/cspReportCollector.ts`](.vitepress/csp/cspReportCollector.ts)
so it is unit-testable without the Netlify runtime. Once the logs show no
`script-src` violations in production, `'unsafe-inline'` can be dropped from the
enforcing `script-src` (see the `@todo` in `netlify.toml`). No environment
variables or external services are required — the collector is same-origin.

## Git hooks

Managed with [Husky](https://typicode.github.io/husky):

- **pre-commit** — [gitleaks](https://github.com/gitleaks/gitleaks) secret scan
- **pre-push** — lint, typecheck and tests
- **post-merge** — reinstalls dependencies when the lockfile changes

Install gitleaks locally (`brew install gitleaks`) so the pre-commit hook can run.
