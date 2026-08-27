// The Wanderist trip-log figure: US states visited out of the total. This is
// the single source for both the "47 / 50 states" caption and the heatmap grid
// in NeonPixelsPage.vue, so the picture (cell count and lit count) can never
// drift from the label again.
export const STATES_TOTAL = 50;
export const STATES_VISITED = 47;

// A visited (lit) cell whenever this index crosses into the next visited slot,
// which spreads the visited states evenly across the grid — the unvisited gaps
// scatter through the heatmap rather than clumping in one corner. The predicate
// is `ceil((index+1)*visited/total) > ceil(index*visited/total)`, written with
// the `+ total - 1` integer-ceiling idiom; the ceiling form (not floor) lights
// cell 0, since an empty top-left corner reads as a missing cell. Summed over
// every index it still yields exactly `visited` lit cells for any total.
function isVisitedCell(index: number, total: number, visited: number): boolean {
  return (
    Math.floor(((index + 1) * visited + total - 1) / total) >
    Math.floor((index * visited + total - 1) / total)
  );
}

function isImpossibleFigure(total: number, visited: number): boolean {
  if (!Number.isInteger(total) || !Number.isInteger(visited)) {
    return true;
  }
  return total < 1 || visited < 0 || visited > total;
}

// One boolean per state — visited (a lit cell) or not — derived from the figure
// so the heatmap renders exactly `total` cells with `visited` lit rather than a
// hand-typed pattern. Fails loudly if the figure is impossible.
export function buildStateVisits(total: number, visited: number): boolean[] {
  if (isImpossibleFigure(total, visited)) {
    throw new Error(`Invalid states figure: ${visited} visited of ${total}`);
  }
  return Array.from({ length: total }, (_unused, index) =>
    isVisitedCell(index, total, visited),
  );
}

export const STATE_VISITS = buildStateVisits(STATES_TOTAL, STATES_VISITED);
