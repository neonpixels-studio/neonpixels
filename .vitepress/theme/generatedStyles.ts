import { BRAND_ACCENTS, WORDMARK_GRADIENT, withAlpha } from "./brand";
import { PROJECTS, type Project } from "./data/projects";
import { hexToRgba } from "./utils/color";

// The enforced Content-Security-Policy has no 'unsafe-inline' for styles, and a
// hash cannot cover a `style` attribute, so no rendered element may carry one.
// Static values are Tailwind classes or rules in style.css. Values that are
// derived from TypeScript data (the brand accents and the per-project colors)
// are generated here as one class per value and emitted by config.ts in a single
// `<style>` element in the page head, which the build hashes like any other
// inline style. The values stay computed from BRAND_ACCENTS, PROJECTS and
// hexToRgba, so a palette change recolors every consumer in lockstep.

export type Declarations = Record<string, string>;
export type StyleRules = Record<string, Declarations>;

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const AURORA_FADE = "transparent 62%";
const HEADING_GLOW_ALPHA = 0.6;
const CTA_FILL_SHADOW_ALPHA = 0.35;
const CTA_FILL_HOVER_ALPHA = 0.6;

// Trip-log heatmap for the FarFlung card: each cell is one of four brightness
// states so the grid reads as visited / partly / faint / empty. The lit states
// are the cyan accent at descending alpha; the alpha suffixes (88/55 hex) fade
// it toward the empty tint.
export const TRIP_CELL_COLORS = {
  on: BRAND_ACCENTS.cyan,
  mid: withAlpha(BRAND_ACCENTS.cyan, "88"),
  low: withAlpha(BRAND_ACCENTS.cyan, "55"),
  off: "#0e2831",
};

export type TripCellState = keyof typeof TRIP_CELL_COLORS;

// Basin aggregates a mixed feed; the leading dot fades with recency via
// descending alpha suffixes on the amber accent (88/55/33 hex). Only the
// freshest item (index 0) glows.
const BASIN_DOT_COLORS = [
  BRAND_ACCENTS.amber,
  withAlpha(BRAND_ACCENTS.amber, "88"),
  withAlpha(BRAND_ACCENTS.amber, "55"),
  withAlpha(BRAND_ACCENTS.amber, "33"),
];

export function basinDotClass(feedIndex: number) {
  return `basin-dot-${feedIndex}`;
}

export function tripCellClass(state: TripCellState) {
  return `trip-cell-${state}`;
}

export type ProjectStylePart =
  | "section"
  | "top-line"
  | "aurora"
  | "pill"
  | "pill-dot"
  | "accent"
  | "cta-fill"
  | "heading-glow";

export function projectStyleClass(projectId: string, part: ProjectStylePart) {
  return `project-${projectId}-${part}`;
}

// The same radial wash at different accents: hero auroras and project auroras.
function auroraGlow(accent: string, alpha: number) {
  return `radial-gradient(circle, ${hexToRgba(accent, alpha)}, ${AURORA_FADE})`;
}

// The three cards share one 60px ambient-glow shape at their accent.
function cardGlow(accent: string, alpha: number) {
  return `0 0 60px ${hexToRgba(accent, alpha)}`;
}

function brandRules(): StyleRules {
  return {
    "wordmark-gradient": { "background-image": WORDMARK_GRADIENT },
    "hero-aurora-lime": { background: auroraGlow(BRAND_ACCENTS.lime, 0.16) },
    "hero-aurora-pink": { background: auroraGlow(BRAND_ACCENTS.pink, 0.15) },
    "hero-aurora-cyan": { background: auroraGlow(BRAND_ACCENTS.cyan, 0.13) },
    "hero-rule-glow": { "box-shadow": `0 0 6px ${BRAND_ACCENTS.lime}` },
    "nav-dot-glow": { "box-shadow": `0 0 8px ${BRAND_ACCENTS.lime}` },
    "glow-grimicorn": { "box-shadow": cardGlow(BRAND_ACCENTS.lime, 0.1) },
    "glow-farflung": { "box-shadow": cardGlow(BRAND_ACCENTS.cyan, 0.1) },
    "glow-basin": { "box-shadow": cardGlow(BRAND_ACCENTS.amber, 0.09) },
    "glow-markpost-out": {
      "box-shadow": `0 0 50px ${hexToRgba(BRAND_ACCENTS.pink, 0.12)}`,
    },
    "glow-markpost-arrow": {
      "text-shadow": `0 0 14px ${hexToRgba(BRAND_ACCENTS.pink, 0.8)}`,
    },
  };
}

function tripCellRules(): StyleRules {
  const rules: StyleRules = {};
  for (const [state, color] of Object.entries(TRIP_CELL_COLORS)) {
    rules[tripCellClass(state as TripCellState)] = { "--trip-cell-bg": color };
  }
  rules[tripCellClass("on")]["box-shadow"] = `0 0 8px ${BRAND_ACCENTS.cyan}`;
  return rules;
}

function basinDotRules(): StyleRules {
  const rules: StyleRules = {};
  BASIN_DOT_COLORS.forEach((color, feedIndex) => {
    rules[basinDotClass(feedIndex)] = { background: color };
  });
  rules[basinDotClass(0)]["box-shadow"] = `0 0 8px ${BRAND_ACCENTS.amber}`;
  return rules;
}

function assertSafeProjectId(projectId: string) {
  if (PROJECT_ID_PATTERN.test(projectId)) {
    return;
  }
  throw new Error(
    `generatedStyles: project id "${projectId}" cannot be used in a CSS class name`,
  );
}

function projectRules(project: Project): StyleRules {
  assertSafeProjectId(project.id);
  const { color, section } = project;
  const rule = (part: ProjectStylePart) => projectStyleClass(project.id, part);
  return {
    [rule("section")]: { background: section.background },
    [rule("top-line")]: { background: section.topLine },
    [rule("aurora")]: {
      "--np-aurora-dur": section.aurora.duration,
      background: auroraGlow(color, section.aurora.alpha),
    },
    [rule("pill")]: {
      color,
      "border-color": project.pillBorder,
      background: project.pillBg,
      "--pill-bg-hover": project.pillBgHover,
      "--accent": color,
    },
    [rule("pill-dot")]: {
      background: color,
      "box-shadow": `0 0 7px ${color}`,
    },
    [rule("accent")]: { "--accent": color },
    // Every CTA exposes --accent so the global :focus-visible ring tracks the
    // project color; the filled variant layers its glow shadow on top.
    [rule("cta-fill")]: {
      "--accent": color,
      "box-shadow": `0 0 26px ${hexToRgba(color, CTA_FILL_SHADOW_ALPHA)}`,
      "--accent-glow": hexToRgba(color, CTA_FILL_HOVER_ALPHA),
    },
    [rule("heading-glow")]: {
      "text-shadow": `0 0 18px ${hexToRgba(color, HEADING_GLOW_ALPHA)}`,
    },
  };
}

// `prop:value;prop:value`, the body of a rule (or of a style attribute).
export function formatDeclarations(declarations: Declarations) {
  return Object.entries(declarations)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

export function buildGeneratedRules(
  projects: Project[] = PROJECTS,
): StyleRules {
  return {
    ...brandRules(),
    ...tripCellRules(),
    ...basinDotRules(),
    ...Object.assign({}, ...projects.map(projectRules)),
  };
}

// One rule per line, no nesting and no braces inside a value, so the output stays
// trivially greppable and hashes the same on every build.
export function buildGeneratedCss(projects: Project[] = PROJECTS) {
  return Object.entries(buildGeneratedRules(projects))
    .map(
      ([className, declarations]) =>
        `.${className}{${formatDeclarations(declarations)}}`,
    )
    .join("\n");
}
