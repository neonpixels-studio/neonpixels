# Neon Pixels

Landing page for [neonpixels.dev](https://neonpixels.dev) — a very small studio and one very caffeinated agent, shipping the tools we kept wishing existed.

Built with [VitePress](https://vitepress.dev) and a fully custom [Tailwind CSS v4](https://tailwindcss.com) theme (no default VitePress chrome).

## Requirements

- Node.js — the version pinned in [`.nvmrc`](.nvmrc) (`nvm use`)
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) (optional, e.g. `brew install gitleaks`) — the pre-commit hook scans staged changes for secrets. Without it the hook prints a warning and skips the scan; CI runs gitleaks on pull requests and pushes to `main`, but branches pushed before a PR is opened are not scanned

## Getting started

```bash
npm install
npm run dev
```

The site is a single custom-themed page. The theme lives in `.vitepress/theme`:

- `AppLayout.vue` — swaps between the landing page and the 404 view
- `components/NeonPixelsPage.vue` — the landing page
- `components/ContactForm.vue` — the Netlify Forms contact form, rendered above the header
- `components/NotFound.vue` — the 404 view
- `style.css` — Tailwind entry, theme tokens, keyframes and animation utilities

## Scripts

| Script                     | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`              | Start the local dev server                                                           |
| `npm run build`            | Build the static site to `.vitepress/dist`                                           |
| `npm run build:production` | Production build with `.env.production` decrypted by dotenvx (needs the private key) |
| `npm run preview`          | Preview the production build locally                                                 |
| `npm test`                 | Run the test suite in watch mode                                                     |
| `npm run test:ci`          | Run the test suite once                                                              |
| `npm run typecheck`        | Type-check with `vue-tsc`                                                            |
| `npm run lint`             | Check formatting (Prettier) and lint (ESLint)                                        |
| `npm run lint:fix`         | Auto-fix formatting and lint issues                                                  |
| `npm run e2e`              | Real-browser (Playwright, Chromium) smoke test against the built `dist`              |
| `npm run audit`            | Audit all dependencies (dev included) with the local allowlisted gate                |
| `npm run check:overrides`  | Fail if a package.json override forces a consumer onto an incompatible version       |

## Testing

Tests use [Vitest](https://vitest.dev) with `happy-dom` and `@vue/test-utils`. They
cover the components, the SEO/social metadata in `config.ts` (Open Graph and Twitter
cards, favicons resolve to real files), the Netlify security headers, and the ESLint
accessibility ruleset.

`npm run e2e` runs a [Playwright](https://playwright.dev) smoke test in real Chromium against
the built site (run `npm run build` first; first-time setup is
`npx playwright install chromium`). It serves `.vitepress/dist` with the response
headers (including the enforced CSP) read from the build's generated `_headers` file, fails on any
Content-Security-Policy violation, and covers the consent banner, contact form hydration, and
error reporting. Google Tag, Sentry ingest and the Netlify Forms POST are intercepted, so
nothing leaves the machine unless a page triggers a CSP violation: the browser would then
send its report to Sentry (and the run fails).
The server listens on port 4321; set `E2E_PORT` to change it.

## Tooling config

Prettier, TypeScript, ESLint, Vitest, Playwright, and fallow settings come from the
shared [`@neon-pixels`](https://github.com/neonpixels-studio/packages) packages
(`@neon-pixels/prettier-config`, `@neon-pixels/tsconfig`, `@neon-pixels/eslint-config`,
`@neon-pixels/vitest-preset`, `@neon-pixels/playwright-preset`, and
`@neon-pixels/fallow-config`). The config files in this repo hold only what is specific
to it: aliases, ignores, the test `include` glob, the e2e serve command, and the
port.

## Deployment

Deploys to [Netlify](https://www.netlify.com). See [`netlify.toml`](netlify.toml) for
the build command, publish directory and security headers. The build runs the test
suite before building, so a failing test blocks the deploy.

### Production build secrets (dotenvx)

Build secrets (the Sentry source map upload token and friends) live in the
encrypted [`.env.production`](.env.production), committed to the repo.
[`.env.example`](.env.example) lists every variable name and where its value
comes from. Netlify holds exactly one secret, `DOTENV_PRIVATE_KEY_PRODUCTION`
(Site configuration > Environment variables, **Production context only**); the
production build command is `npm run build:production`, which runs
`dotenvx run --strict -f .env.production -- npm run build`. `--strict` makes the
build fail loudly when the key is missing rather than building without the
values. Deploy Previews, branch deploys, CI, the dependency audit and Lighthouse
use the plain `npm run build` and never need the key.

- **Add or change a value:** run `npx dotenvx set KEY value -f .env.production`
  with the private key available locally (keep the value out of shell history,
  for example `"$(pbpaste)"` as the value, then clear the clipboard), commit the re-encrypted file, and add
  the name and its source to `.env.example` (a test fails if the two files
  disagree on variable names or if any value is stored unencrypted).
- **Where the private key lives:** in the maintainer's password manager, in a
  git-ignored local `.env.keys` file when editing values, and in Netlify as
  `DOTENV_PRIVATE_KEY_PRODUCTION`. It is never committed.
- **Rotate the key:** run `npx dotenvx rotate -f .env.production` (generates a
  new key pair and re-encrypts every value), commit the updated
  `.env.production`, replace `DOTENV_PRIVATE_KEY_PRODUCTION` in Netlify with the
  new private key, then redeploy. Rotate the underlying secrets too if the old
  key may have leaked, since the old ciphertext stays in git history.

### Deploys

Production deploys once a week, Mondays 14:00 UTC, through a Netlify build hook
triggered by the `Weekly production deploy` workflow. Merging to `main` does not
deploy. Pull requests get Deploy Previews as usual. To ship a hotfix, go to the
Actions tab > Weekly production deploy > Run workflow (on `main`). A run does
nothing when the live deploy is already built from the current `main` commit. Deploys started
from the Netlify UI on `main` are cancelled by the ignore gate; use the workflow
instead. GitHub disables scheduled workflows after 60 days without repository
activity; re-enable it from the Actions tab if that happens.

The workflow keeps its own `e2e` browser gate (build plus Playwright), and its
`deploy` job `needs` it. The deploy itself is the shared reusable workflow
`production-deploy.yml` from [`neonpixels-studio/packages`](https://github.com/neonpixels-studio/packages),
which runs the `np-should-deploy` and `np-verify-netlify-deploy` bins from
[`@neon-pixels/scripts`](https://github.com/neonpixels-studio/packages/tree/main/packages/scripts):

- It skips when the live Netlify deploy is already built from the current `main`
  commit, rather than looking for commits in the last 7 days.
- It fires the build hook with a title unique to the run, then polls the Netlify API
  (30 minute timeout) until that deploy is `ready` and was built from the checked
  commit. Because the build command runs the full test suite, a red build leaves
  production stale; any non-success outcome (failed, cancelled, timed out) fails the
  run and opens a `deploy-failure` issue (or comments on the open one). A later
  verified deploy closes it.
- It needs three repository secrets, passed by name: `NETLIFY_BUILD_HOOK_URL` (the URL
  of a Netlify build hook for branch `main`, created under Site configuration > Build &
  deploy > Continuous deployment > Build hooks), `NETLIFY_AUTH_TOKEN` (a Netlify
  personal access token: User settings > Applications > Personal access tokens) and
  `NETLIFY_SITE_ID` (Site configuration > Site details > Project ID). The run fails
  before firing the hook if one is missing.

### Shared CI tooling

CI scripts, reusable workflows and synced files come from
[`neonpixels-studio/packages`](https://github.com/neonpixels-studio/packages):

- `@neon-pixels/scripts` is a dev dependency at an exact version. Every
  `scripts-version` input in `.github/workflows` must use the same version (a test
  checks it). The reusable workflows are pinned to one full commit SHA of the packages
  repo; Dependabot moves that SHA, but `scripts-version` is bumped by hand.
- Secret scan: the `gitleaks` job in `security.yml` calls the reusable `gitleaks.yml`.
- Dependency audit: `security.yml` runs the reusable `dependency-audit.yml` for
  production dependencies, plus the local `npm run audit` gate over all dependencies
  (almost everything here is a dev dependency). Either failing opens the scheduled
  audit-failure issue. `npm run check:overrides` is specific to this repo.
- Lighthouse: the `lighthouse` job in `ci.yml` calls the reusable `lighthouse.yml` with
  `.lighthouserc.json`. It builds the site itself, one extra build per audited run.
- CI runs `np-check-action-pinning` (every action pinned to a full SHA with a version
  comment) and `np-sync-templates --stack vitepress --check`.
- `npx np-sync-templates --stack vitepress` rewrites `.nvmrc`, `.gitleaks.toml`,
  `.github/dependabot.yml`, the husky hooks and `package.json` `engines` from the
  shared templates. Put repo-specific lines inside the `np-sync:begin` / `np-sync:end`
  sections (gitleaks `extra-rules` and `allowlist`, hook `repo-specific`); everything
  else is overwritten.

### Contact form ([Netlify Forms](https://docs.netlify.com/manage/forms/setup/))

`components/ContactForm.vue` is a real HTML `<form data-netlify="true" name="contact">`
(with a hidden `form-name` input) rendered unconditionally in the page template, so it
survives into the static HTML VitePress emits at build time — this is what lets
Netlify's build-time bot detect and register it; a form that only materialized after
client-side hydration would never be picked up. At runtime the component submits via
`fetch` (isolated in `theme/forms/submitNetlifyForm.ts`) to avoid a full page reload,
posting the same url-encoded body a native submission would. Spam filtering uses an
accessible honeypot field (`bot-field`, `data-netlify-honeypot`) that's hidden from
sighted users and assistive tech and removed from the tab order, so only an automated
filler ever populates it; a filled honeypot reports success without actually
submitting (it logs a PII-free `console.info` marker so a false-positive catch is
diagnosable). **No new environment variables or build config are required** — Netlify
auto-detects the form from the deployed HTML. To receive submissions by email, enable
notifications once per site: Netlify dashboard → Site configuration → Forms →
Form notifications.

### Error reporting (Sentry)

Browser errors are reported to [Sentry](https://sentry.io) with `@sentry/vue`,
configured by the shared filter lists and scrubber from `@neon-pixels/sentry`
([`.vitepress/theme/error-reporting.ts`](.vitepress/theme/error-reporting.ts)).

- **When it runs:** only in the browser and only in a production build (`vitepress dev`
  and the static render never load it). The SDK is a separate chunk, fetched with a
  dynamic import once the page has loaded and the browser is idle, so it is not in the
  entry bundle. Errors thrown before it starts (during hydration or before the browser goes
  idle) are not reported. A failure to load or start it is logged to the console and never
  breaks the page.
- **What it sends:** errors only (component errors and unhandled promise rejections).
  No tracing, no Session Replay, no session tracking, no user info, no cookies, so it
  does not depend on analytics consent. Events pass through `scrubEvent` before they
  leave the browser, and only errors from scripts on the site's own origin are kept.
  [`PrivacyPolicy.vue`](.vitepress/theme/components/PrivacyPolicy.vue) tells visitors
  what is sent.
- **Environment:** `resolveSentryEnvironment` maps Netlify's `CONTEXT` at build time, so
  deploy previews report as `preview` and only the production deploy reports as
  `production`. A bare local build reports as `development`.
- **DSN:** a public value, committed as `SENTRY_DSN` in
  [`.vitepress/sentry-dsn.ts`](.vitepress/sentry-dsn.ts). Its ingest origin is the only
  Sentry host allowed in `connect-src` in the generated policy; `netlify.test.ts` fails if the
  two drift apart.
- **E2E:** every Playwright test intercepts requests to the ingest origin, so the suite
  never sends anything to Sentry.

#### Source maps (optional)

When `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` are **all** set in the build
environment, the build generates hidden source maps, uploads them with
`@sentry/vite-plugin`, and deletes them. When any is missing, the build uploads nothing
and logs `Sentry source map upload skipped`. Either way the build fails if a `.map` file
or a `sourceMappingURL` comment is left in `.vitepress/dist`
([`scan-source-maps.ts`](.vitepress/scan-source-maps.ts)). Supply the three variables
through the encrypted `.env.production` (see
[Production build secrets](#production-build-secrets-dotenvx)) or the Netlify
environment; never put a value in a committed plaintext file.

### Content-Security-Policy

The site enforces one hashed policy and sends no `'unsafe-inline'` for scripts or
styles. `buildEnd` in `.vitepress/config.ts` calls `writeHeadersFile` from
`@neon-pixels/security/netlify` (through
[`.vitepress/csp/writeSiteHeaders.ts`](.vitepress/csp/writeSiteHeaders.ts)) after the
build, which hashes every inline `<script>` and `<style>` in the built HTML and appends
the security headers and the policy to the `_headers` file in `.vitepress/dist`. The
hashes come from the real build output, so they cannot drift.

- **Policy:** the package's first-party base plus the Google Analytics sources
  (`script-src`, `img-src`, `connect-src`), the Sentry ingest origin in `connect-src`,
  `base-uri 'self'`, and `form-action 'self'`. The sources live in
  [`.vitepress/csp/sitePolicy.ts`](.vitepress/csp/sitePolicy.ts).
- **No inline style attributes:** a hash cannot cover a `style` attribute, an inline
  event handler or a `javascript:` URL, so the build fails if any page has one. Values
  that come from data (accent colors, glows, gradients) are generated as classes by
  [`.vitepress/theme/generatedStyles.ts`](.vitepress/theme/generatedStyles.ts) and
  emitted in one hashed `<style>` element in the page head. Static values are Tailwind
  classes or rules in `style.css`.
- **Headers:** `netlify.toml` keeps only `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Resource-Policy`. Every other security header is written to `_headers`
  by the build, so each header is set in exactly one place. The `noindex` header for
  deploy previews and branch deploys is appended to the generated `/*` policy block.
- **Reports:** violations go to this site's Sentry project through its security
  endpoint (`SENTRY_SECURITY_REPORT_URL` in
  [`.vitepress/csp/sitePolicy.ts`](.vitepress/csp/sitePolicy.ts)), tagged
  `sentry_environment=production` on a production build and `preview` on a deploy
  preview or branch deploy. The URL holds the public DSN key; no environment variable
  or secret is involved.
- **E2E:** `npm run e2e` serves the built `dist` with the headers from the generated
  `_headers` file, so the browser enforces exactly what production serves, and the smoke
  spec fails on any Content-Security-Policy violation.

## Git hooks

Managed with [Husky](https://typicode.github.io/husky):

- **pre-commit** — `dotenvx ext precommit` (blocks a plaintext `.env*` commit) and a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan
- **pre-push** — lint, typecheck and tests
- **post-merge** — reinstalls dependencies when the lockfile changes

Install gitleaks locally (`brew install gitleaks`) so the pre-commit hook can run.
