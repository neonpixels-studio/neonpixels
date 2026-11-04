import axe from "axe-core";
import { JSDOM } from "jsdom";

// jsdom rather than happy-dom (already a devDependency): axe-core officially
// supports jsdom and has known gaps on happy-dom. Do not consolidate them.
//
// jsdom neither lays out nor loads linked stylesheets, so elements hidden only
// by external CSS look visible to axe. A future failure on a visually hidden
// element (e.g. the skip link) is likely that limitation, not a real defect.
const AXE_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// jsdom has no layout engine, so axe cannot compute rendered colors. Contrast is
// covered statically by wcag-text-contrast.test.ts instead.
const AXE_DISABLED_RULES = ["color-contrast"];

const AXE_RUN_OPTIONS: axe.RunOptions = {
  resultTypes: ["violations"],
  runOnly: { type: "tag", values: AXE_WCAG_TAGS },
  rules: Object.fromEntries(
    AXE_DISABLED_RULES.map((ruleId) => [ruleId, { enabled: false }]),
  ),
};

export type AxeViolationSummary = {
  id: string;
  impact: axe.ImpactValue | null | undefined;
  help: string;
  targets: string[];
};

function summarizeViolations(violations: axe.Result[]): AxeViolationSummary[] {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

export async function runAxeOnHtml(
  html: string,
): Promise<AxeViolationSummary[]> {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  try {
    dom.window.eval(axe.source);
    const results = await (
      dom.window as unknown as { axe: typeof axe }
    ).axe.run(dom.window.document, AXE_RUN_OPTIONS);
    return summarizeViolations(results.violations);
  } finally {
    dom.window.close();
  }
}
