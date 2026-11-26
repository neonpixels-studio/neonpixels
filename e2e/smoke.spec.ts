import { expect, test, type Page } from "@playwright/test";
import {
  loadEnforcedCsp,
  loadGeneratedHeaders,
} from "./support/enforcedCsp.ts";
import { trackCspViolations } from "./support/cspViolations.ts";
import { trackPageErrors } from "./support/pageErrors.ts";
import { SENTRY_INGEST_ORIGIN } from "../.vitepress/sentry-dsn.ts";

const GTAG_URL_PATTERN = "https://www.googletagmanager.com/gtag/js**";
const CONSENT_STORAGE_KEY = "neonpixels:analytics-consent";
// Chromium logs the 404 navigation itself as a console error; it is the one
// expected entry on the 404 page.
const DOCUMENT_404_CONSOLE_ERROR =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";
const GTAG_STUB = "window.__gtagStubLoaded = true;";

const SENTRY_INGEST_PATTERN = `${SENTRY_INGEST_ORIGIN}/**`;
// How long a started SDK gets to send something it should not.
const SENTRY_SETTLE_MS = 1000;
const SENTRY_THROW_SCRIPT_PATH = "/e2e-sentry-throw.js";
const SENTRY_THROW_SCRIPT = "Promise.reject(new Error('e2e sentry check'));";

// Requests the page sent to Sentry's ingest origin during the current test.
// Every test intercepts them (see the beforeEach below), so nothing ever
// reaches the real project.
let sentryRequests: string[] = [];

test.beforeEach(async ({ page }) => {
  sentryRequests = [];
  await page.route(SENTRY_INGEST_PATTERN, async (route) => {
    sentryRequests.push(route.request().url());
    await route.fulfill({ status: 200, body: "{}" });
  });
});

// Stubs the Google Tag loader so nothing leaves the machine, while still
// counting requests. The stub is served as a real script, so the page's CSP
// still has to allow the origin for it to execute.
async function stubGtag(page: Page) {
  const requests: string[] = [];
  await page.route(GTAG_URL_PATTERN, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: "text/javascript", body: GTAG_STUB });
  });
  return requests;
}

// Intercepts the Netlify Forms POST so no test ever reaches the real backend.
// The mutable `response` lets a test flip the endpoint from failing to
// succeeding between submits.
async function interceptFormPosts(
  page: Page,
  response: { status: number } = { status: 200 },
) {
  const formPosts: string[] = [];
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      formPosts.push(route.request().postData() ?? "");
      await route.fulfill({ status: response.status, body: "ok" });
    },
  );
  return formPosts;
}

function readStoredConsent(page: Page) {
  return page.evaluate((key) => {
    const rawValue = window.localStorage.getItem(key);
    return rawValue === null ? null : JSON.parse(rawValue).choice;
  }, CONSENT_STORAGE_KEY);
}

function consentBanner(page: Page) {
  return page.getByRole("region", { name: "Analytics consent" });
}

test("serves the production CSP header", async ({ page }) => {
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toBe(loadEnforcedCsp());
  expect(csp).not.toContain("unsafe-inline");
});

test("serves every header the build generated", async ({ page }) => {
  const response = await page.goto("/");
  const served = response?.headers() ?? {};
  for (const [name, value] of Object.entries(loadGeneratedHeaders())) {
    expect(served[name.toLowerCase()], name).toBe(value);
  }
});

test.describe("consent banner", () => {
  test("accept loads gtag, persists, and reloads without the banner", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    const gtagRequests = await stubGtag(page);

    await page.goto("/");
    await expect(consentBanner(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(gtagRequests).toHaveLength(0);

    await consentBanner(page).getByRole("button", { name: "Accept" }).click();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => gtagRequests.length).toBe(1);
    await page.waitForLoadState("networkidle");
    expect(gtagRequests).toHaveLength(1);
    await expect.poll(() => readStoredConsent(page)).toBe("granted");

    await page.reload();
    await expect(consentBanner(page)).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Analytics choice" }),
    ).toBeVisible();
    await expect.poll(() => gtagRequests.length).toBe(2);
    await page.waitForLoadState("networkidle");
    expect(gtagRequests).toHaveLength(2);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("decline never loads gtag and the choice survives a reload", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    const gtagRequests = await stubGtag(page);

    await page.goto("/");
    await consentBanner(page).getByRole("button", { name: "Decline" }).click();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => readStoredConsent(page)).toBe("denied");

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Analytics choice" }),
    ).toBeVisible();
    await expect(consentBanner(page)).toBeHidden();
    expect(gtagRequests).toHaveLength(0);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("contact form", () => {
  test("hydrated empty submit shows the invalid state and does not navigate", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);
    const formPosts = await interceptFormPosts(page);

    await page.goto("/");
    const form = page.locator("form[name='contact']");
    // novalidate is only set after hydration, so this proves Vue hydrated.
    await expect(form).toHaveAttribute("novalidate", "");

    const startUrl = page.url();
    await form.getByRole("button", { name: "send message" }).click();

    await expect(page.locator("#contact-email-error")).toHaveText(
      "Enter your email address.",
    );
    await expect(page.locator("#contact-message-error")).toHaveText(
      "Enter a message.",
    );
    await expect(page.locator("#contact-email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator("#contact-email")).toBeFocused();
    expect(page.url()).toBe(startUrl);
    expect(formPosts).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("valid submit posts to the intercepted endpoint and shows success", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);
    const formPosts = await interceptFormPosts(page);

    await page.goto("/");
    const form = page.locator("form[name='contact']");
    await expect(form).toHaveAttribute("novalidate", "");
    await page.locator("#contact-email").fill("dev@example.com");
    await page.locator("#contact-message").fill("Hello from the smoke test");
    await form.getByRole("button", { name: "send message" }).click();

    await expect(page.getByRole("status")).toContainText("that landed");
    expect(formPosts).toHaveLength(1);
    expect(formPosts[0]).toContain("form-name=contact");
    expect(formPosts[0]).toContain("email=dev%40example.com");
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("contact form server error", () => {
  test("a 500 shows the alert, keeps the fields, and a retry succeeds", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);
    const response = { status: 500 };
    const formPosts = await interceptFormPosts(page, response);

    await page.goto("/");
    const form = page.locator("form[name='contact']");
    await expect(form).toHaveAttribute("novalidate", "");
    await page.locator("#contact-email").fill("dev@example.com");
    await page.locator("#contact-message").fill("Hello from the smoke test");
    await form.getByRole("button", { name: "send message" }).click();

    await expect(page.getByRole("alert")).toHaveText(
      "That didn't send. Please try again in a moment.",
    );
    await expect(page.getByRole("status")).toBeEmpty();
    await expect(page.locator("#contact-email")).toHaveValue("dev@example.com");
    await expect(page.locator("#contact-message")).toHaveValue(
      "Hello from the smoke test",
    );
    expect(formPosts).toHaveLength(1);
    expect(formPosts[0]).toContain("form-name=contact");
    expect(formPosts[0]).toContain("email=dev%40example.com");
    expect(formPosts[0]).toContain("message=Hello+from+the+smoke+test");

    response.status = 200;
    await form.getByRole("button", { name: "send message" }).click();

    await expect(page.getByRole("status")).toContainText("that landed");
    await expect(page.getByRole("alert")).toBeEmpty();
    expect(formPosts).toHaveLength(2);
    expect(formPosts[1]).toContain("form-name=contact");
    expect(formPosts[1]).toContain("email=dev%40example.com");
    expect(formPosts[1]).toContain("message=Hello+from+the+smoke+test");
    expect(cspViolations).toEqual([]);
    // A failed submit yields two expected console errors: the browser's own
    // failed-resource line and the component's log. Anything else is a bug.
    const unexpectedErrors = pageErrors.filter(
      (message) => !message.includes("Failed to load resource"),
    );
    expect(unexpectedErrors).toHaveLength(1);
    expect(unexpectedErrors[0]).toContain("Contact form submission failed");
  });
});

test.describe("error reporting", () => {
  test("an unhandled rejection from a site script reaches the intercepted ingest origin without a CSP violation", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    await stubGtag(page);
    await page.route(`**${SENTRY_THROW_SCRIPT_PATH}`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: SENTRY_THROW_SCRIPT,
      }),
    );

    await page.goto("/");
    // The SDK starts once the page is idle, so wait for it before throwing.
    await page.waitForFunction(() => "__SENTRY__" in window);
    await expect
      .poll(async () => {
        await page.evaluate((path) => {
          const script = document.createElement("script");
          script.src = path;
          document.body.append(script);
        }, SENTRY_THROW_SCRIPT_PATH);
        return sentryRequests.length;
      })
      .toBeGreaterThan(0);
    expect(cspViolations).toEqual([]);
  });

  test("a normal page load sends nothing to Sentry", async ({ page }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);

    await page.goto("/");
    // The SDK registers its global once initialized, so an empty list below
    // proves a running SDK sent nothing rather than one that never started.
    await page.waitForFunction(() => "__SENTRY__" in window);
    await page.waitForTimeout(SENTRY_SETTLE_MS);
    // The SDK flushes sessions and client reports when the page is hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(SENTRY_SETTLE_MS);
    expect(sentryRequests).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("privacy page", () => {
  test("/privacy rewrite hydrates and reopens the analytics choice", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);

    const response = await page.goto("/privacy");
    expect(response?.status()).toBe(200);
    expect(page.url()).toMatch(/\/privacy$/);
    await expect(
      page.getByRole("heading", { level: 1, name: /privacy/i }),
    ).toBeVisible();

    await consentBanner(page).getByRole("button", { name: "Decline" }).click();
    await expect(consentBanner(page)).toBeHidden();
    await page.getByRole("button", { name: "Analytics choice" }).click();
    await expect(consentBanner(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe("404 page", () => {
  test("serves NotFound with a 404 status, hydrates, and echoes the path", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const pageErrors = trackPageErrors(page);
    await stubGtag(page);

    const response = await page.goto("/does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
    // The path echo is only filled in on mount, so this proves hydration.
    await expect(page.locator("main")).toContainText("cat /does-not-exist");
    await page.waitForLoadState("networkidle");
    expect(cspViolations).toEqual([]);
    expect(pageErrors).toEqual([DOCUMENT_404_CONSOLE_ERROR]);
  });
});
