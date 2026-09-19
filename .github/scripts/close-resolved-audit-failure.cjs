// Called from .github/workflows/security.yml's "close-resolved-audit-failure"
// job (which runs only when the `audit` job it depends on succeeds on the
// Monday schedule) via actions/github-script. Mirrors why
// notify-audit-failure.cjs is a plain module rather than inline YAML: the
// recovery logic here — finding the right issue(s) and closing exactly those
// — is the part with an actual failure mode, so it's unit-tested against a
// stubbed `github` client instead of only grepped as source text. Kept as
// CommonJS (.cjs) for the same reason as notify-audit-failure.cjs:
// package.json sets "type": "module", so a plain .js here would be parsed as
// ESM by Node and `module.exports`/`require` would fail at runtime in the
// workflow.
//
// Reuses notify-audit-failure.cjs's `findOpenAuditFailureIssues` rather than
// re-deriving the label/body-marker matching rules, so the close path always
// targets exactly the issue(s) that script opened — one lookup, shared by
// both directions of this feature.
const { findOpenAuditFailureIssues } = require("./notify-audit-failure.cjs");

// Closes first, comments second: closing is the state change that actually
// stops the issue from piling up; the comment is purely cosmetic context for
// whoever reads the issue afterward. That asymmetry means the two calls need
// different failure handling, not a single try/catch around both: a failed
// close is this feature failing at its one job (report it as such, and
// leave the issue for the next run to retry), but a failed comment on an
// issue that *did* close successfully is not a failed close — reporting it
// as "failed to close audit-failure issue #7" would be false, and would send
// a maintainer to investigate a stuck-open issue that's actually already
// closed. `core.warning` still surfaces the comment failure as a visible
// workflow annotation, so it isn't silently swallowed either.
async function closeAuditFailureIssue({
  github,
  owner,
  repo,
  issue,
  runUrl,
  core,
}) {
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issue.number,
    state: "closed",
  });
  core.info(`Closed resolved audit-failure issue #${issue.number}.`);

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `The scheduled security audit passed again. Closing this issue.\n\nRecovered run: ${runUrl}`,
    });
  } catch (error) {
    core.warning(
      `Closed audit-failure issue #${issue.number} but could not post the recovery comment: ${error.message}`,
    );
  }
}

module.exports = async function closeResolvedAuditFailure({
  github,
  context,
  core,
}) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  // No try/catch here, same rationale as notify-audit-failure.cjs: a broken
  // lookup should surface loudly in the workflow log rather than be
  // swallowed, since a silently-broken closer would let stale audit-failure
  // issues pile up unnoticed — the exact failure mode this feature exists
  // to prevent.
  const trackedIssues = await findOpenAuditFailureIssues({
    github,
    owner,
    repo,
  });

  if (trackedIssues.length === 0) {
    core.info("No open audit-failure issue to close.");
    return;
  }

  // Normally at most one tracked issue is open, but when more than one is
  // (a human reopens one, two scheduled runs race), one issue failing to
  // *close* (e.g. a transient API error) must not abort the rest — otherwise
  // a single stuck issue would permanently mask every other issue this loop
  // exists to clear. Close failures are collected instead, and the run
  // still fails loud afterward so a broken closer surfaces in the workflow
  // log rather than being swallowed silently. Comment failures never reach
  // here — closeAuditFailureIssue handles those itself (see above).
  const closeFailures = [];
  for (const issue of trackedIssues) {
    try {
      await closeAuditFailureIssue({
        github,
        owner,
        repo,
        issue,
        runUrl,
        core,
      });
    } catch (error) {
      closeFailures.push(`#${issue.number}: ${error.message}`);
    }
  }

  if (closeFailures.length > 0) {
    throw new Error(
      `Failed to close audit-failure issue(s): ${closeFailures.join("; ")}`,
    );
  }
};
