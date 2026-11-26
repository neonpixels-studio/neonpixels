import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createApp, type App } from "vue";
import {
  addBreadcrumb,
  close,
  getClient,
  type BrowserOptions,
} from "@sentry/vue";
import { scrubEvent } from "@neon-pixels/sentry";

import { initErrorReporting } from "@theme/error-reporting";

// Wraps the real scrubber in a spy so a test can prove an event reached
// beforeSend, while the SDK still runs the real thing.
vi.mock("@neon-pixels/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neon-pixels/sentry")>();
  return { ...actual, scrubEvent: vi.fn(actual.scrubEvent) };
});

const DSN = "https://publicKey@o123.ingest.us.sentry.io/456";
const ORIGIN = "https://neonpixels.dev";
const ENVIRONMENT = "preview";

// Derived from the SDK's own transport type: @sentry/core is installed twice
// at different versions, so importing its Envelope type directly would not match.
type SdkTransport = ReturnType<NonNullable<BrowserOptions["transport"]>>;
type Envelope = Parameters<SdkTransport["send"]>[0];
type EnvelopeItem = [unknown, { exception?: { values?: unknown[] } }];

const sentEnvelopes: Envelope[] = [];

// A transport that records envelopes and never touches the network.
function stubTransport() {
  return {
    send: async (envelope: Envelope) => {
      sentEnvelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  };
}

function sentExceptions() {
  return sentEnvelopes
    .flatMap((envelope) => envelope[1] as unknown as EnvelopeItem[])
    .map(([, payload]) => JSON.stringify(payload.exception?.values ?? []));
}

// The SDK drops errors whose stack has no frame from an allowed origin, and a
// vitest stack points at a local file, so give the error a first-party frame.
function errorFrom(scriptUrl: string, message: string) {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${scriptUrl}:1:1`;
  return error;
}

function rejectionOf(reason: Error) {
  return Object.assign(new Event("unhandledrejection"), {
    reason,
    promise: Promise.resolve(),
  });
}

function startReporting(app: App = createApp({})) {
  initErrorReporting(app, {
    dsn: DSN,
    environment: ENVIRONMENT,
    origin: ORIGIN,
    transport: stubTransport,
  });
  return app;
}

function clientOptions() {
  const options = getClient()?.getOptions();
  if (!options) {
    throw new Error("Sentry was not initialized");
  }
  return options;
}

const matchesAny = (rules: (string | RegExp)[] | undefined, value: string) =>
  (rules ?? []).some((rule) =>
    typeof rule === "string" ? value.includes(rule) : rule.test(value),
  );

beforeEach(() => {
  sentEnvelopes.length = 0;
  vi.mocked(scrubEvent).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

describe("initErrorReporting configuration", () => {
  it("initializes the SDK with the DSN and the build's environment", () => {
    startReporting();
    expect(clientOptions().dsn).toBe(DSN);
    expect(clientOptions().environment).toBe(ENVIRONMENT);
  });

  it("scrubs events through the shared scrubber", () => {
    startReporting();
    expect(clientOptions().beforeSend).toBe(scrubEvent);
  });

  it("sends no client reports for events the filters drop", () => {
    startReporting();
    expect(clientOptions().sendClientReports).toBe(false);
  });

  it("collects no user info and no cookies", () => {
    startReporting();
    expect(clientOptions().dataCollection).toEqual({
      userInfo: false,
      cookies: false,
    });
  });

  it("enables no tracing and no session replay", () => {
    startReporting();
    const options = clientOptions();
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.tracesSampler).toBeUndefined();
    const names = (options.integrations ?? []).map(({ name }) => name);
    expect(names).not.toContain("Replay");
    expect(names).not.toContain("BrowserTracing");
  });

  it("drops release-health session tracking and keeps every other default", () => {
    startReporting();
    const names = (getClient()?.getOptions().integrations ?? []).map(
      ({ name }) => name,
    );
    expect(names).not.toContain("BrowserSession");
    expect(names).toContain("GlobalHandlers");
  });

  it("allows only scripts from the site's own origin", () => {
    startReporting();
    const { allowUrls } = clientOptions();
    expect(matchesAny(allowUrls, `${ORIGIN}/assets/app.abc.js`)).toBe(true);
    expect(matchesAny(allowUrls, "https://cdn.example.com/inject.js")).toBe(
      false,
    );
  });

  it("denies browser-extension script URLs", () => {
    startReporting();
    expect(
      matchesAny(clientOptions().denyUrls, "chrome-extension://abc/content.js"),
    ).toBe(true);
    expect(
      matchesAny(clientOptions().denyUrls, `${ORIGIN}/assets/app.js`),
    ).toBe(false);
  });

  it("ignores the benign ResizeObserver notice only", () => {
    startReporting();
    const { ignoreErrors } = clientOptions();
    expect(matchesAny(ignoreErrors, "ResizeObserver loop limit exceeded")).toBe(
      true,
    );
    expect(matchesAny(ignoreErrors, "TypeError: x is undefined")).toBe(false);
  });
});

describe("initErrorReporting event capture", () => {
  it("reports an error thrown in a component through beforeSend", async () => {
    const Broken = {
      setup() {
        throw errorFrom(`${ORIGIN}/assets/app.js`, "component exploded");
      },
    };
    const app = createApp(Broken);
    startReporting(app);

    // Vue rethrows after the SDK's errorHandler has run, outside production.
    expect(() => app.mount(document.createElement("div"))).toThrow(
      "component exploded",
    );

    await vi.waitFor(() => expect(sentExceptions()).toHaveLength(1));
    expect(scrubEvent).toHaveBeenCalledOnce();
    expect(sentExceptions()[0]).toContain("component exploded");
  });

  it("reports an unhandled promise rejection through beforeSend", async () => {
    startReporting();

    window.dispatchEvent(
      rejectionOf(errorFrom(`${ORIGIN}/assets/app.js`, "promise rejected")),
    );

    await vi.waitFor(() => expect(sentExceptions()).toHaveLength(1));
    expect(scrubEvent).toHaveBeenCalledOnce();
    expect(sentExceptions()[0]).toContain("promise rejected");
  });

  it("sends nothing for an error from a script outside the site", async () => {
    startReporting();

    window.dispatchEvent(
      rejectionOf(
        errorFrom("chrome-extension://abc/content.js", "from an extension"),
      ),
    );
    // A first-party sentinel proves the transport works and the earlier event
    // had its chance to arrive: only the sentinel may be sent.
    window.dispatchEvent(
      rejectionOf(errorFrom(`${ORIGIN}/assets/app.js`, "sentinel")),
    );

    await vi.waitFor(() => expect(sentExceptions()).toHaveLength(1));
    expect(sentExceptions()[0]).toContain("sentinel");
    expect(sentExceptions()[0]).not.toContain("from an extension");
  });

  it("strips query strings and fragments from navigation breadcrumbs", async () => {
    startReporting();
    addBreadcrumb({
      category: "navigation",
      data: { from: "/", to: "/privacy?utm_source=secret#section-token" },
    });

    window.dispatchEvent(
      rejectionOf(errorFrom(`${ORIGIN}/assets/app.js`, "with breadcrumb")),
    );

    await vi.waitFor(() => expect(sentEnvelopes).toHaveLength(1));
    const sent = JSON.stringify(sentEnvelopes);
    expect(sent).toContain("with breadcrumb");
    expect(sent).not.toContain("utm_source=secret");
    expect(sent).not.toContain("section-token");
  });
});
