// Shared tabbable-element selector so every spec that reasons about Tab order
// (the skip-link ordering check in AppLayout.test.ts) and about focusable
// descendants (the aria-hidden visual guard in NeonPixelsPage.test.ts) agrees on
// exactly what counts as a Tab stop — a single owner, so the two can never drift.
//
// Excludes the not-tabbable cases on every branch: disabled controls, a negative
// tabindex (matched programmatically but never on Tab, so the exclusion has to
// hang off each term, not just the trailing [tabindex]), contenteditable="false",
// and a bare <summary> outside <details>. Media elements only count with
// controls; object/embed are omitted as they aren't reliable tab stops across
// engines.
export const TABBABLE_SELECTOR =
  'a[href]:not([tabindex^="-"]), area[href]:not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), input:not([disabled]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), iframe:not([tabindex^="-"]), audio[controls]:not([tabindex^="-"]), video[controls]:not([tabindex^="-"]), details > summary:not([tabindex^="-"]), [contenteditable]:not([contenteditable="false"]):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';
