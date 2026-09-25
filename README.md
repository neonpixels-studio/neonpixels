# Neon Pixels

Landing page for [neonpixels.dev](https://neonpixels.dev) — a very small studio and one very caffeinated agent, shipping the tools we kept wishing existed.

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
`<receivedAt ISO timestamp, colons/periods replaced with dashes>-<rollout|other tag>-<uuid>.json`,
the tag derived from whether the violation's own `effectiveDirective` belongs
to the `script-src` family — see `isRolloutKey` below for what the tag is
for) so the rollout signal is queryable instead of grep-only. Being public and
unauthenticated, the Function's `config` also sets a Netlify
[rate limit](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)
(60 requests per 60s, aggregated per IP + domain) so a single caller can't
write faster than the scheduled pruner below can realistically keep up with;
it's a per-caller cap, not a global one, so it doesn't stop a distributed
flood across many IPs — the store-side retention/count cap is what still
bounds that case. A violation whose
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
so it is unit-testable without the Netlify runtime. Once the logs show no
`script-src` violations **and no `csp-report-rejected` or `csp-report-unparsed`
entries** over the observation window, `'unsafe-inline'` can be dropped from the
enforcing `script-src` (see the `@todo` in `netlify.toml`). The two markers
matter: a request rejected for an unmodelled content type or an unrecognized
body shape would otherwise read as "no violations", so a clean run must show
neither.

Since `/csp-report` is public and unauthenticated, sustained abuse could grow
the `csp-reports` store without bound. An hourly Netlify scheduled Function
([`netlify/functions/csp-report-prune.ts`](netlify/functions/csp-report-prune.ts))
prunes it: blobs older than `CSP_REPORT_RETENTION_DAYS` (default 30, clamped to
`MAX_RETENTION_DAYS`) are always deleted, and whatever the run saw is then
trimmed to `CSP_REPORT_MAX_BLOBS` (default 5000, clamped to `MAX_MAX_BLOBS`)
— including on a run that couldn't finish listing the whole store, since the
count it did see is still a valid lower bound on the real total. Both are
optional site environment variables (set via the Netlify dashboard or CLI,
not a `.env` file — this repo has none) for tuning the window/cap without a
code change; neither is required for pruning to run.

The count-cap trim is not plain oldest-first: non-rollout (`other`-tagged,
i.e. not `script-src` family) reports are evicted oldest-first ahead of every
rollout-tagged one, so the script-src rollout signal below can't be starved
by an attacker flooding `/csp-report` with fabricated non-`script-src`
reports (#135) — rollout keys are only reached once the non-rollout backlog
is exhausted and the store is still over cap (see `isRolloutKey`/`overCapKeys`
in [`cspReportPruner.ts`](netlify/functions/lib/cspReportPruner.ts)). A key
written before this tagging existed is treated as rollout (protected) rather
than `other`, so pre-existing evidence isn't penalized for predating the tag
— for up to `CSP_REPORT_RETENTION_DAYS` after this shipped, that means a
brand-new genuine non-rollout report can be evicted ahead of untagged legacy
noise from before the tag existed; retention still ages every untagged key
out within that same window, so the effect is bounded to one retention
window and self-corrects. This still isn't a forgery-proof guarantee: the tag
is derived from the violation's own self-reported `effectiveDirective`, the
same attacker-controlled field discussed above for `documentUrl` — a flood
that also forges `effectiveDirective: "script-src"` lands in the protected
class too, and eviction within that class is still oldest-first, so it can
still evict genuine, older `script-src` evidence; the fail-closed gate on the
rollout signal itself (`missingEntries` etc., described below) is what still
holds against that case. Because the count cap has no per-caller identity, a
flood larger than `CSP_REPORT_MAX_BLOBS` within one run can still evict every
non-rollout historical report along with the flood — a deliberate trade-off
favoring "the store never grows unbounded" over "every genuine report is
preserved forever" (bounded, since #135, to non-rollout reports first); the
endpoint's own rate limit (above) narrows how much a single caller can
contribute to that within one hour, but raise the cap further if the
trade-off stops being acceptable. Netlify scheduled Functions
have a hard 30s execution limit, so the list and delete passes each run
against their own wall-clock budget (`LIST_TIME_BUDGET_MS` /
`PRUNE_TIME_BUDGET_MS`) rather than sharing one deadline — otherwise a slow
listing pass over a large store could consume the entire run and leave the
delete pass no time at all. Those budgets are cooperative (checked between
pages/batches, not during a single slow call), so the handler additionally
races the whole `prune()` call against a `HARD_TIMEOUT_MS` hard timeout
(`netlify/functions/lib/withTimeout.ts`, shared with the Blobs-write timeout
above) that always wins against Netlify's real 30s limit — without it, a
single hung Blobs call could get the whole run killed with nothing logged.
No cursor is persisted between runs, but pruning is self-correcting: a key
that's still stale or still over the cap next hour gets picked up again on
the next hourly run. The prune strategy is isolated in
[`netlify/functions/lib/cspReportPruner.ts`](netlify/functions/lib/cspReportPruner.ts)
behind a minimal `list`/`delete` seam (mirroring `BlobWriter` above), so it is
unit-tested with a fake client rather than the real Blobs store. A failed or
incomplete prune run logs a `csp-report-prune-failed` marker or a `complete:
false` result via `csp-report-pruned` and tries again on the next scheduled
run; it never blocks or slows the `/csp-report` endpoint itself.

A logged marker alone is easy to miss — nobody watches the Function logs
continuously, so a prune run that starts failing (or a token that silently
expires) could go unnoticed indefinitely, defeating the one thing keeping the
`csp-reports` store bounded. On a failed run, the handler additionally opens
(or comments on, if one's already open) a GitHub issue labeled
`csp-prune-failure`, via
[`netlify/functions/lib/notifyPruneFailure.ts`](netlify/functions/lib/notifyPruneFailure.ts)
(see issue #123). This mirrors the duplicate-guard pattern the scheduled
security-audit workflow already uses
([`.github/scripts/notify-audit-failure.cjs`](.github/scripts/notify-audit-failure.cjs)):
one open issue per failure streak (matched by a marker in the issue body, not
just the label, since the label alone could be applied to an unrelated issue
during triage), closing it lets the next failure open a new one. That script
runs inside a GitHub Actions job and authenticates via
`actions/github-script`'s built-in Octokit client; this Netlify Function has
no such client available at runtime, so it talks to the GitHub REST API
directly over `fetch`, authenticated with a **fine-grained GitHub PAT scoped
to this repo's Issues: write permission only**, set as the
`PRUNE_FAILURE_GITHUB_TOKEN` Netlify site environment variable (dashboard or
CLI, not a `.env` file — this repo has none). That token is **not** required
for pruning itself to run — only for this failure-notification path to reach
GitHub; a missing/invalid token is caught and logged as a
`csp-report-prune-notify-failed` marker rather than affecting the run's own
500 response. The duplicate-guard logic is isolated behind a
`GithubIssuesClient` seam (mirroring `BlobWriter`/`BlobPrunerClient` above),
so it is unit-tested against a fake client rather than the real GitHub API.
**Setup:** the `csp-prune-failure` label must already exist on the repo
before the first failure — create it once
(`gh label create csp-prune-failure --color B60205 --description "The scheduled csp-report-prune Function failed"`)
— since this notifier only applies the label to issues it creates, it never
creates the label itself.

Writing and pruning the store still left no way to read it back, so the
rollout question it exists to answer — has `script-src` actually stopped
firing — could only be checked by grepping raw per-violation log lines. A
second, daily Netlify scheduled Function
([`netlify/functions/csp-report-summary.ts`](netlify/functions/csp-report-summary.ts))
reads and aggregates the store: counts of stored violations by
`effectiveDirective` and by `blockedUri`, plus an explicit rollout signal —
how many stored violations belong to the `script-src` family (`script-src`
itself plus the `script-src-elem`/`script-src-attr` sub-directives browsers
report even though this site never declares them separately) and, if any
remain, the most recent one. Since the pruner above now protects rollout-
tagged reports first under count-cap pressure, the `byDirective`/`byBlockedUri`
breakdowns (not the rollout signal itself) can skew toward `script-src` during
and after a sustained flood — treat them as unreliable totals for non-
`script-src` directives in that case; the rollout signal, the property #135
cares about, is unaffected. Reading the store scales with its size the same
way pruning does, so the list and fetch passes each carry their own
cooperative time budget (`LIST_TIME_BUDGET_MS`/`SUMMARY_TIME_BUDGET_MS` in
`lib/cspReportSummary.ts`, split the same way the pruner splits its budget
across list/delete) — a store too large to read in one run still returns a
real, partial summary (`complete: false`) instead of the whole run being
discarded. A truncated fetch pass reads the listed keys newest-first (not
whatever order `list()` happened to return), so it's the oldest evidence
that gets dropped, not the most recent — but that ordering only applies to
keys the list pass itself managed to retain; when `listComplete` is false
too, `rollout.mostRecent` and the two breakdowns above are not reliably "the
newest" (`rollout.stopped` is unaffected, since it already fails closed on
`complete` regardless). The signal fails closed: it only reports
`stopped: true` once
nothing belongs to `script-src` **and** nothing went unread **and** the run
itself was complete — no failed fetch, no key the pruner's count-cap pass
evicted mid-walk, no key the time budget never got to
(`fetchFailures`/`missingEntries`/`invalidEntries` all 0 and `complete:
true`), since any of those could have been hiding a script-src violation
this run simply lost the race to see. It is deliberately _not_ gated on the
store being non-empty, though —
an empty store read cleanly is the designed end state of a successful
rollout, not a fault, and treating it as "can't tell" would make `stopped`
permanently unreachable once retention (`CSP_REPORT_RETENTION_DAYS`) rolls
the last evidence off; a collector that stops receiving traffic entirely is
already a distinct, more precise failure covered by its own signal
(`csp-report-persist-failed` in `csp-report.ts`). Once the signal does report
stopped, `'unsafe-inline'` can be dropped from the enforcing `script-src`
(see the `@todo` in `netlify.toml`). It's scheduled rather than a public
route for the same reason the pruner's list/delete pass gets away with being
unauthenticated: Netlify doesn't expose a scheduled Function's route to
arbitrary callers, which matters here because the summary's most-recent
violation embeds attacker-influenced fields (`blockedUri`, `sourceFile`,
`sample`) that must not be readable at a public, unauthenticated endpoint.
It's also invokable on demand — `netlify functions:invoke csp-report-summary`
against a linked site — for an ad-hoc rollout check without waiting for the
schedule. Like the pruner, the read path is isolated in
[`netlify/functions/lib/cspReportSummary.ts`](netlify/functions/lib/cspReportSummary.ts)
behind a minimal `list`/`get` seam (`BlobSummaryClient`, mirroring
`BlobPrunerClient`), so the aggregation is unit-tested with a fake client
rather than the real Blobs store; a `get()` failure or an unrecognized blob
shape is counted and logged (`csp-report-summary-fetch-failed` /
`csp-report-summary-invalid-entry`) rather than aborting the whole run, and a
rejected `list()` page degrades the same way (`csp-report-summary-list-failed`)
— a key the pruner deleted mid-walk is tracked separately (`missingEntries`,
never logged since a vanished key isn't evidence of a corrupted blob, but
still part of the fail-closed rollout gate above). Each run logs its outcome
on two lines: `csp-report-summarized` carries the rollout signal and totals,
and `csp-report-summary-breakdown` carries the `byDirective`/`byBlockedUri`
counts (capped to the top 20 each) — split and capped because `blockedUri` is
attacker-influenced free text arriving through a public endpoint, so an
unbounded breakdown could otherwise grow into a multi-hundred-KB single log
line and risk the rollout signal itself being truncated. A run cut short by
its own time budget — whether by the list/fetch deadlines running out or a
`list()`/`get()` call failing outright — still logs those two lines with real
(if partial) data and a 200, plus a separate `csp-report-summary-incomplete`
warning so a store consistently too large to finish in one run has its own
greppable, alertable signal — unlike the hourly pruner's self-correcting next
run, there's no other run coming to surface the problem on its own. Only a
genuine hang past the hard timeout, or a failure outside the list/fetch seams
entirely (e.g. `getStore` itself throwing), still logs
`csp-report-summary-failed` and a 500, mirroring
`csp-report-pruned`/`csp-report-prune-failed` above. On a failed run, the
handler also opens (or comments on, if one's already open) a GitHub issue
labeled `csp-summary-failure`, via
[`netlify/functions/lib/notifySummaryFailure.ts`](netlify/functions/lib/notifySummaryFailure.ts)
(see issue #137) — the same duplicate-guard notification the pruner gets
(above), since a silently-broken summary run would otherwise mean nobody is
ever told the `script-src` rollout signal has gone stale. The generic
list/comment/create mechanics (fetch adapter, error redaction, re-notify
throttling) are shared with the prune notifier via
[`netlify/functions/lib/githubFailureNotifier.ts`](netlify/functions/lib/githubFailureNotifier.ts)
— each notifier supplies only its own label/title/body-marker. Unlike the
hourly prune notifier, the summary notifier disables the re-notify throttle
(`renotifyIntervalMs: 0`): its `@daily` cadence is already sparser than any
useful throttle window, so every failed run comments/opens rather than
risking a whole day's failure going unreported. They reuse the same
`PRUNE_FAILURE_GITHUB_TOKEN` Netlify site environment variable, since its
actual scope (a fine-grained PAT with Issues: write on this repo) was never
prune-specific; a missing/invalid token here is caught and logged as a
`csp-report-summary-notify-failed` marker, mirroring
`csp-report-prune-notify-failed` above. **Setup:** the `csp-summary-failure` label must already exist
on the repo before the first failure — create it once
(`gh label create csp-summary-failure --color B60205 --description "The scheduled csp-report-summary Function failed"`)
— since this notifier only applies the label to issues it creates, it never
creates the label itself.

## Git hooks

Managed with [Husky](https://typicode.github.io/husky):

- **pre-commit** — [gitleaks](https://github.com/gitleaks/gitleaks) secret scan
- **pre-push** — lint, typecheck and tests
- **post-merge** — reinstalls dependencies when the lockfile changes

Install gitleaks locally (`brew install gitleaks`) so the pre-commit hook can run.
