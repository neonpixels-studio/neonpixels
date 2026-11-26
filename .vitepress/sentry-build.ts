import { sentryVitePlugin } from "@sentry/vite-plugin";

// Build-time half of Sentry error reporting (the browser half is
// theme/error-reporting.ts). Source maps are generated and uploaded only when
// all three variables below are set, whether from the encrypted .env.production
// (see `npm run build:production`) or the Netlify environment. Without them
// nothing is generated or uploaded.

type BuildEnvironment = Record<string, string | undefined>;
type ConfigEnvironment = { command?: string; isSsrBuild?: boolean };

const UPLOAD_VARIABLES = [
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
] as const;
// The client build's output. Hidden source maps are uploaded, then deleted so
// they never deploy.
const SOURCE_MAP_FILES_GLOB = ".vitepress/dist/**/*.map";

export const UPLOAD_SKIPPED_MESSAGE = `Sentry source map upload skipped: ${UPLOAD_VARIABLES.join(", ")} are not all set.`;

export function shouldUploadSourceMaps(environment: BuildEnvironment) {
  return UPLOAD_VARIABLES.every((name) => Boolean(environment[name]));
}

// VitePress runs a client and an SSR build through the same plugin list. Only
// the client bundle reaches browsers, so only its maps are worth uploading, and
// never in the dev server.
function isClientBuild(_config: unknown, configEnvironment: ConfigEnvironment) {
  return configEnvironment.command === "build" && !configEnvironment.isSsrBuild;
}

export function buildSentryVitePlugins(environment: BuildEnvironment) {
  if (!shouldUploadSourceMaps(environment)) {
    return [];
  }
  const plugins = sentryVitePlugin({
    authToken: environment.SENTRY_AUTH_TOKEN,
    org: environment.SENTRY_ORG,
    project: environment.SENTRY_PROJECT,
    telemetry: false,
    sourcemaps: { filesToDeleteAfterUpload: [SOURCE_MAP_FILES_GLOB] },
  });
  return plugins.map((plugin) => ({ ...plugin, apply: isClientBuild }));
}
