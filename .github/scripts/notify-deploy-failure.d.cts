// Hand-written declaration for notify-deploy-failure.cjs; see
// notify-audit-failure.d.cts for why it exists and why `export default`.

import type {
  NotifyGithubIssuesClient,
  AuditWorkflowContext,
  AuditWorkflowCore,
} from "./notify-audit-failure.cjs";

export type NotifyDeployFailureArgs = {
  github: { rest: { issues: NotifyGithubIssuesClient } };
  context: AuditWorkflowContext;
  core: AuditWorkflowCore;
};

declare function notifyDeployFailure(
  args: NotifyDeployFailureArgs,
): Promise<void>;

declare namespace notifyDeployFailure {
  const DEPLOY_FAILURE_LABEL: string;
  const ISSUE_TITLE: string;
  const ISSUE_MARKER: string;
}

export default notifyDeployFailure;
