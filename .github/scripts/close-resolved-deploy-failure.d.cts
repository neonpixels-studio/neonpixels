// Hand-written declaration for close-resolved-deploy-failure.cjs; see
// close-resolved-audit-failure.d.cts for why it exists and why
// `export default`.

import type { CloseGithubIssuesClient } from "./close-resolved-audit-failure.cjs";
import type {
  AuditWorkflowContext,
  AuditWorkflowCore,
} from "./notify-audit-failure.cjs";

export type CloseResolvedDeployFailureArgs = {
  github: { rest: { issues: CloseGithubIssuesClient } };
  context: AuditWorkflowContext;
  core: AuditWorkflowCore & { warning: (_message: string) => void };
};

declare function closeResolvedDeployFailure(
  _args: CloseResolvedDeployFailureArgs,
): Promise<void>;

export default closeResolvedDeployFailure;
