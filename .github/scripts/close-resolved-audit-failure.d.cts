// Hand-written declaration for close-resolved-audit-failure.cjs, mirroring
// notify-audit-failure.d.cts: the script stays plain CommonJS because it's
// loaded at runtime via require() from actions/github-script (see
// .github/workflows/security.yml), not through this repo's Vite/TS
// toolchain, but closeResolvedAuditFailure.test.ts still wants static types
// when importing it. See notify-audit-failure.d.cts for why `export default`
// is used instead of the more literally-accurate CJS `export =`.

import type { NotifyAuditFailureArgs } from "./notify-audit-failure.cjs";

export type CloseResolvedAuditFailureArgs = NotifyAuditFailureArgs;

declare function closeResolvedAuditFailure(
  _args: CloseResolvedAuditFailureArgs,
): Promise<void>;

export default closeResolvedAuditFailure;
