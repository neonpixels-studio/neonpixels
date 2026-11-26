import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { BRAND_ACCENTS } from "@theme/brand";
import { STATES_TOTAL, STATES_VISITED, STATE_VISITS } from "@theme/data/states";
import { buildGeneratedRules, tripCellClass } from "@theme/generatedStyles";

// The FarFlung trip-log heatmap must render one cell per state (STATES_TOTAL)
// with exactly the visited count lit (STATES_VISITED), so the picture matches
// the "47 / 50 states" caption. Both the caption and the cells derive from the
// states figure, so a hardcoded cell string or caption would fail here.
const HEATMAP_SELECTOR = '[data-testid="trip-log-heatmap"]';
const CELL_SELECTOR = '[data-testid="trip-log-cell"]';

// Every lit brightness (on / mid / low) is the cyan accent, optionally with an
// alpha suffix; the empty tint carries no cyan. Read the `--trip-cell-bg` custom
// property of the generated class alone (not the whole rule, which also holds the
// box-shadow) so a future cyan glow on an empty cell can't be miscounted as lit.
const CELL_STATES = ["on", "mid", "low", "off"] as const;

function tripCellState(cell: { element: Element }) {
  return CELL_STATES.find((state) =>
    cell.element.classList.contains(tripCellClass(state)),
  );
}

function tripCellBackground(cell: { element: Element }) {
  const state = tripCellState(cell);
  if (!state) {
    return "";
  }
  return buildGeneratedRules()[tripCellClass(state)]["--trip-cell-bg"] ?? "";
}

function isLitCell(cell: { element: Element }) {
  return tripCellBackground(cell).startsWith(BRAND_ACCENTS.cyan);
}

describe("NeonPixelsPage trip-log heatmap", () => {
  let wrapper!: VueWrapper;

  beforeEach(() => {
    wrapper = mount(NeonPixelsPage);
  });

  afterEach(() => {
    wrapper.unmount();
  });

  it("renders one cell per state", () => {
    const cells = wrapper.get(HEATMAP_SELECTOR).findAll(CELL_SELECTOR);
    expect(cells).toHaveLength(STATES_TOTAL);
  });

  it("lights exactly the visited count of cells", () => {
    const cells = wrapper.get(HEATMAP_SELECTOR).findAll(CELL_SELECTOR);
    const litCells = cells.filter((cell) => isLitCell(cell));
    expect(litCells).toHaveLength(STATES_VISITED);
  });

  it("lights the cells the states figure marks visited, in order", () => {
    const cells = wrapper.get(HEATMAP_SELECTOR).findAll(CELL_SELECTOR);
    expect(cells.map((cell) => isLitCell(cell))).toEqual([...STATE_VISITS]);
  });

  it("captions the heatmap with the same states figure", () => {
    expect(wrapper.text()).toContain(
      `${STATES_VISITED} / ${STATES_TOTAL} states`,
    );
  });

  // The historical bug was the footer total and the aria-label disagreeing with
  // the caption (a footer reading 26 under a 47/50 caption). Assert both against
  // the states figure directly so the snapshot isn't the only thing standing
  // between a regenerated 26 and a shipped contradiction.
  it("labels the mockup image with the same states figure", () => {
    expect(wrapper.get('[role="img"]').attributes("aria-label")).toContain(
      `${STATES_VISITED} of ${STATES_TOTAL} US states`,
    );
  });

  it("footers the same visited total as the caption", () => {
    expect(wrapper.get('[role="img"]').text()).toContain(
      `${STATES_VISITED} states`,
    );
  });

  // The fill reaches the cell through a generated class that sets the
  // `--trip-cell-bg` custom property, so style.css's forced-colors override on
  // `.trip-cell` stays reachable and the cell carries no style attribute (the
  // page's Content-Security-Policy forbids one).
  it("fills each cell through a generated class, never a style attribute", () => {
    const cells = wrapper.get(HEATMAP_SELECTOR).findAll(CELL_SELECTOR);
    cells.forEach((cell) => {
      expect(cell.attributes("style")).toBeUndefined();
      expect(tripCellState(cell)).toBeDefined();
      expect(tripCellBackground(cell)).not.toBe("");
    });
  });

  // The forced-colors fill (style.css's `.trip-cell[data-visited="true"]`)
  // keys on this attribute, not on --trip-cell-bg, so it needs its own
  // guard against drifting from the visited count it's meant to mirror.
  it("marks exactly the visited count of cells data-visited", () => {
    const visitedCells = wrapper
      .get(HEATMAP_SELECTOR)
      .findAll('[data-visited="true"]');
    expect(visitedCells).toHaveLength(STATES_VISITED);
  });
});
