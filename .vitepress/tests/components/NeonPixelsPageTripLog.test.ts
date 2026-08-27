import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import NeonPixelsPage from "@components/NeonPixelsPage.vue";
import { BRAND_ACCENTS } from "@theme/brand";
import { STATES_TOTAL, STATES_VISITED } from "@theme/data/states";

// The Wanderist trip-log heatmap must render one cell per state (STATES_TOTAL)
// with exactly the visited count lit (STATES_VISITED), so the picture matches
// the "47 / 50 states" caption. Both the caption and the cells derive from the
// states figure, so a hardcoded cell string or caption would fail here.
const HEATMAP_SELECTOR = '[data-testid="trip-log-heatmap"]';
const CELL_SELECTOR = '[data-testid="trip-log-cell"]';

// Every lit brightness (on / mid / low) is the cyan accent, optionally with an
// alpha suffix; the empty tint carries no cyan. Inspect the background alone
// (not the whole style string, which also holds the box-shadow) so a future
// cyan border or glow on an empty cell can't be miscounted as lit.
function isLitCell(cell: { element: Element }) {
  const background = (cell.element as HTMLElement).style.background;
  return background.startsWith(BRAND_ACCENTS.cyan);
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

  it("captions the heatmap with the same states figure", () => {
    expect(wrapper.text()).toContain(
      `${STATES_VISITED} / ${STATES_TOTAL} states`,
    );
  });
});
