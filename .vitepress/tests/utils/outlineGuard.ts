// SUPPRESSED_OUTLINE_PATTERN is shared by the global-stylesheet guard
// (style.test.ts) and the component-file guard (component-focus.test.ts) so the
// two checks match the same suppressions and neither drifts stale. Comment
// handling is NOT shared: style.css is pure CSS and strips only /* */, while
// component files also carry HTML and JS comments — hence stripComments lives
// here for the component guard only.

// The ways an outline gets silently killed in CSS: none / 0 / transparent, on
// the shorthand or a longhand, with or without !important. The terminator
// closes on `;`/`}` (a CSS rule) or a quote (an inline `style="outline:none"`
// attribute in template markup).
export const SUPPRESSED_OUTLINE_PATTERN =
  /outline(-style|-width|-color)?:\s*(none|0(px)?|transparent)\s*(!important)?\s*[;}"']/;

// Tailwind utilities that hide the ring from markup. v4 split the old behaviour:
// `outline-none` sets outline-style:none and `outline-hidden` sets a transparent
// outline — both defeat the visible :focus-visible ring. Matches the bare class
// or any variant prefix (focus:, focus-visible:, etc.).
export const OUTLINE_UTILITY_PATTERN = /\boutline-(none|hidden)\b/;

// Strip CSS block, HTML, and JS line comments so prose or a commented-out
// example can neither trip nor mask a match. The negative class before `//`
// keeps protocol (`https://`) and protocol-relative (`url(//cdn…)`, `src="//…"`)
// URLs from being mistaken for a line comment, which would otherwise fail open
// by deleting a real declaration sharing that line.
export function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:("'])\/\/.*$/gm, "$1");
}
