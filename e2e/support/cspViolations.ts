import type { Page } from "@playwright/test";

const CSP_CONSOLE_PATTERN = /content security policy/i;

// Collects every CSP complaint Chromium raises (console errors plus the
// securitypolicyviolation event) so a spec can assert the list stays empty.
export async function trackCspViolations(page: Page) {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (CSP_CONSOLE_PATTERN.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  return violations;
}
