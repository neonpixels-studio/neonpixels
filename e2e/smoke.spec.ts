import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { readEnforcedCsp } from "./support/enforcedCsp.ts";
import { trackCspViolations } from "./support/cspViolations.ts";

const GTAG_URL_PATTERN = "https://www.googletagmanager.com/gtag/js**";
const CONSENT_STORAGE_KEY = "np-analytics-consent";
const GTAG_STUB = "window.__gtagStubLoaded = true;";

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
async function interceptFormPosts(page: Page) {
  const formPosts: string[] = [];
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      formPosts.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, body: "ok" });
    },
  );
  return formPosts;
}

function readStoredConsent(page: Page) {
  return page.evaluate(
    (key) => window.localStorage.getItem(key),
    CONSENT_STORAGE_KEY,
  );
}

function consentBanner(page: Page) {
  return page.getByRole("region", { name: "Analytics consent" });
}

test("serves the production CSP header", async ({ page }) => {
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  const netlifyToml = readFileSync(
    resolve(process.cwd(), "netlify.toml"),
    "utf8",
  );
  expect(csp).toBe(readEnforcedCsp(netlifyToml));
});

test.describe("consent banner", () => {
  test("accept loads gtag, persists, and reloads without the banner", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const gtagRequests = await stubGtag(page);

    await page.goto("/");
    await expect(consentBanner(page)).toBeVisible();
    expect(gtagRequests).toHaveLength(0);

    await consentBanner(page).getByRole("button", { name: "Accept" }).click();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => gtagRequests.length).toBe(1);
    await expect.poll(() => readStoredConsent(page)).toBe("accepted");

    await page.reload();
    await expect(consentBanner(page)).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Analytics choice" }),
    ).toBeVisible();
    await expect.poll(() => gtagRequests.length).toBe(2);
    expect(cspViolations).toEqual([]);
  });

  test("decline never loads gtag and the choice survives a reload", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
    const gtagRequests = await stubGtag(page);

    await page.goto("/");
    await consentBanner(page).getByRole("button", { name: "Decline" }).click();
    await expect(consentBanner(page)).toBeHidden();
    await expect.poll(() => readStoredConsent(page)).toBe("declined");

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Analytics choice" }),
    ).toBeVisible();
    await expect(consentBanner(page)).toBeHidden();
    expect(gtagRequests).toHaveLength(0);
    expect(cspViolations).toEqual([]);
  });
});

test.describe("contact form", () => {
  test("hydrated empty submit shows the invalid state and does not navigate", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
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
  });

  test("valid submit posts to the intercepted endpoint and shows success", async ({
    page,
  }) => {
    const cspViolations = await trackCspViolations(page);
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
  });
});
