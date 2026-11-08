// Hand-written declaration for deploy-trigger.cjs: the script is plain
// CommonJS run directly by Node in the workflow, but deployTrigger.test.ts
// wants static types. See notify-audit-failure.d.cts for why `export default`
// is used.

type Env = Record<string, string | undefined>;

declare const deployTrigger: {
  isScheduled: (eventName: string | undefined) => boolean;
  countRecentCommits: () => number;
  checkRecentCommits: (args: {
    eventName: string | undefined;
    countCommits?: () => number;
    writeOutput: (line: string) => void;
    log?: (message: string) => void;
  }) => boolean;
  buildTriggerTitle: (args: {
    eventName: string | undefined;
    runId: string;
    runAttempt: string;
  }) => string;
  encodeTitle: (title: string) => string;
  prepareTrigger: (args: {
    env: Env;
    writeEnv: (line: string) => void;
    print?: (message: string) => void;
  }) => string;
  escapeAnnotation: (message: string) => string;
  main: (argv?: string[], env?: Env) => void;
  WINDOW_DAYS: number;
  SCHEDULED_TITLE: string;
  MANUAL_TITLE: string;
};

export default deployTrigger;
