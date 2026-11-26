import { describe, it, expect } from "vitest";
import {
  UPLOAD_SKIPPED_MESSAGE,
  buildSentryVitePlugins,
  shouldUploadSourceMaps,
} from "../sentry-build";

const UPLOAD_ENVIRONMENT = {
  SENTRY_AUTH_TOKEN: "sntrys_test",
  SENTRY_ORG: "example-org",
  SENTRY_PROJECT: "example-project",
};

type ApplyFunction = (
  _config: unknown,
  _configEnvironment: { isSsrBuild?: boolean },
) => boolean;

describe("shouldUploadSourceMaps", () => {
  it("is on only when the token, org and project are all set", () => {
    expect(shouldUploadSourceMaps(UPLOAD_ENVIRONMENT)).toBe(true);
    expect(shouldUploadSourceMaps({})).toBe(false);
    expect(
      shouldUploadSourceMaps({ ...UPLOAD_ENVIRONMENT, SENTRY_AUTH_TOKEN: "" }),
    ).toBe(false);
    expect(
      shouldUploadSourceMaps({ ...UPLOAD_ENVIRONMENT, SENTRY_ORG: undefined }),
    ).toBe(false);
    expect(
      shouldUploadSourceMaps({ ...UPLOAD_ENVIRONMENT, SENTRY_PROJECT: "" }),
    ).toBe(false);
  });

  it("explains in one line which variables are needed", () => {
    expect(UPLOAD_SKIPPED_MESSAGE).not.toContain("\n");
    expect(UPLOAD_SKIPPED_MESSAGE).toContain("SENTRY_AUTH_TOKEN");
    expect(UPLOAD_SKIPPED_MESSAGE).toContain("SENTRY_ORG");
    expect(UPLOAD_SKIPPED_MESSAGE).toContain("SENTRY_PROJECT");
  });
});

describe("buildSentryVitePlugins", () => {
  it("adds no plugins without the full set of variables", () => {
    expect(buildSentryVitePlugins({})).toEqual([]);
    expect(
      buildSentryVitePlugins({ SENTRY_AUTH_TOKEN: "sntrys_test" }),
    ).toEqual([]);
  });

  it("returns the upload plugins when fully configured", () => {
    const plugins = buildSentryVitePlugins(UPLOAD_ENVIRONMENT);
    expect(plugins.map((plugin) => plugin.name)).toContain(
      "sentry-vite-plugin",
    );
  });

  it("applies every plugin to the client build only, never VitePress's SSR build", () => {
    const plugins = buildSentryVitePlugins(UPLOAD_ENVIRONMENT);
    expect(plugins.length).toBeGreaterThan(0);
    for (const plugin of plugins) {
      const apply = plugin.apply as ApplyFunction;
      expect(apply({}, { isSsrBuild: false })).toBe(true);
      expect(apply({}, { isSsrBuild: true })).toBe(false);
    }
  });
});
