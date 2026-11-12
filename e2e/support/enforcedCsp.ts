import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reads the enforcing Content-Security-Policy straight out of netlify.toml so
// the e2e server sends exactly what production sends. A hand-copied policy
// here would drift and let a real CSP regression pass.
const CSP_HEADER_NAME = "Content-Security-Policy";
// Anchored to line start so the commented prose and the Report-Only header
// (`Content-Security-Policy-Report-Only`) can never match.
// No escape handling on purpose: a policy containing a backslash or quote
// fails to match and throws rather than being served subtly wrong.
const CSP_LINE_PATTERN = new RegExp(
  `^\\s*${CSP_HEADER_NAME}\\s*=\\s*"([^"\\\\]*)"\\s*$`,
  "m",
);

export function readEnforcedCsp(netlifyToml: string): string {
  const match = CSP_LINE_PATTERN.exec(netlifyToml);
  if (!match) {
    throw new Error(`netlify.toml has no enforcing ${CSP_HEADER_NAME} header`);
  }
  return match[1];
}

export function loadEnforcedCsp(
  netlifyTomlPath = resolve(process.cwd(), "netlify.toml"),
) {
  return readEnforcedCsp(readFileSync(netlifyTomlPath, "utf8"));
}

export { CSP_HEADER_NAME };
