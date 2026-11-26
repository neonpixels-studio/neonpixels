/// <reference types="vite/client" />

// Ambient declaration for side-effect CSS imports (e.g. `import "./style.css"`),
// which carry no type information of their own.
declare module "*.css" {}

interface ImportMetaEnv {
  // Defined by vite.define in config.ts; Sentry's environment name.
  readonly VITE_SENTRY_ENVIRONMENT: string;
}
