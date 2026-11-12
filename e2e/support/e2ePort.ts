const DEFAULT_E2E_PORT = 4321;
const MAX_PORT = 65535;

// Shared by playwright.config.ts and serve.ts so the two can never disagree
// on which port the site is served from.
export function readE2ePort(rawPort = process.env.E2E_PORT): number {
  if (rawPort === undefined) {
    return DEFAULT_E2E_PORT;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`E2E_PORT must be an integer from 1 to ${MAX_PORT}`);
  }
  return port;
}
