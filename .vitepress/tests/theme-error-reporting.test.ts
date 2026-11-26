import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { App } from "vue";
import type { EnhanceAppContext } from "vitepress";

const startErrorReporting = vi.hoisted(() => vi.fn());

vi.mock("@theme/start-error-reporting", () => ({ startErrorReporting }));

// The theme reads the baked-in environment at module load, so each test stubs
// the env first and then imports a fresh copy.
async function enhanceFreshTheme() {
  vi.resetModules();
  const { default: theme } = await import("@theme/index");
  const app = {} as App;
  await theme.enhanceApp?.({ app } as EnhanceAppContext);
  return app;
}

beforeEach(() => {
  startErrorReporting.mockReset();
  vi.stubEnv("SSR", false);
  vi.stubEnv("PROD", true);
  vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "preview");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("theme enhanceApp error reporting", () => {
  it("starts error reporting with the app and the baked-in environment in a production browser build", async () => {
    const app = await enhanceFreshTheme();
    expect(startErrorReporting).toHaveBeenCalledOnce();
    expect(startErrorReporting).toHaveBeenCalledWith(app, "preview");
  });

  it("does nothing outside a production build", async () => {
    vi.stubEnv("PROD", false);
    await enhanceFreshTheme();
    expect(startErrorReporting).not.toHaveBeenCalled();
  });

  it("does nothing during server rendering", async () => {
    vi.stubEnv("SSR", true);
    await enhanceFreshTheme();
    expect(startErrorReporting).not.toHaveBeenCalled();
  });
});
