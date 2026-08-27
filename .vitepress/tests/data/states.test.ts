import { describe, it, expect } from "vitest";
import {
  STATES_TOTAL,
  STATES_VISITED,
  STATE_VISITS,
  buildStateVisits,
} from "@theme/data/states";

function litCount(visits: boolean[]) {
  return visits.filter((visited) => visited).length;
}

describe("buildStateVisits", () => {
  it("renders one cell per state with exactly the visited count lit", () => {
    const visits = buildStateVisits(50, 47);
    expect(visits).toHaveLength(50);
    expect(litCount(visits)).toBe(47);
  });

  it("lights nothing when no state is visited", () => {
    const visits = buildStateVisits(5, 0);
    expect(visits).toHaveLength(5);
    expect(litCount(visits)).toBe(0);
  });

  it("lights every cell when all states are visited", () => {
    const visits = buildStateVisits(5, 5);
    expect(litCount(visits)).toBe(5);
  });

  it("spreads exactly the visited count when far from the total", () => {
    const visits = buildStateVisits(10, 3);
    expect(visits).toHaveLength(10);
    expect(litCount(visits)).toBe(3);
  });

  it("scatters the unvisited gaps evenly instead of clumping them", () => {
    const visits = buildStateVisits(50, 47);
    const unvisitedIndexes = visits.flatMap((visited, index) =>
      visited ? [] : [index],
    );
    expect(unvisitedIndexes).toEqual([16, 33, 49]);
    const spacings = unvisitedIndexes
      .slice(1)
      .map((index, position) => index - unvisitedIndexes[position]);
    expect(Math.min(...spacings)).toBeGreaterThan(1);
  });

  it("throws on an impossible figure", () => {
    expect(() => buildStateVisits(5, 6)).toThrow();
    expect(() => buildStateVisits(5, -1)).toThrow();
    expect(() => buildStateVisits(5, 2.5)).toThrow();
    expect(() => buildStateVisits(0, 0)).toThrow();
  });
});

describe("states figure", () => {
  it("derives STATE_VISITS from the published figure", () => {
    expect(STATE_VISITS).toHaveLength(STATES_TOTAL);
    expect(litCount(STATE_VISITS)).toBe(STATES_VISITED);
  });
});
