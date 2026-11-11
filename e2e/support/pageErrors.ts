import type { Page } from "@playwright/test";

// Uncaught exceptions and console errors (Vue hydration mismatches log here
// in production builds) so a spec can assert the page ran clean.
export function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}
