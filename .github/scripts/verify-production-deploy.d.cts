// Hand-written declaration for verify-production-deploy.cjs: the script is
// plain CommonJS run directly by Node in the workflow, but
// verifyProductionDeploy.test.ts wants static types. See
// notify-audit-failure.d.cts for why `export default` is used.

export type DeployOutcome = "success" | "failure" | "cancelled" | "timeout";

export type NetlifyDeploy = {
  state: string;
  error_message?: string;
};

export type PollResult = {
  outcome: DeployOutcome;
  state: string;
  deploy: NetlifyDeploy | null;
};

export type PollArgs = {
  buildId: string;
  fetchDeploy: (buildId: string) => Promise<NetlifyDeploy>;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
};

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type VerifyArgs = {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
};

declare function verifyProductionDeploy(args?: VerifyArgs): Promise<PollResult>;

declare namespace verifyProductionDeploy {
  function classifyDeployState(state: string): DeployOutcome | "pending";
  function parseBuildId(hookResponseBody: string): string;
  function createNetlifyClient(args: {
    token: string;
    fetchImpl?: FetchLike;
  }): { fetchDeploy: (buildId: string) => Promise<NetlifyDeploy> };
  function pollDeployStatus(args: PollArgs): Promise<PollResult>;
  function describeResult(result: PollResult): string;
  const POLL_TIMEOUT_MS: number;
  const OUTCOME_SUCCESS: "success";
  const OUTCOME_FAILURE: "failure";
  const OUTCOME_CANCELLED: "cancelled";
  const OUTCOME_TIMEOUT: "timeout";
}

export default verifyProductionDeploy;
