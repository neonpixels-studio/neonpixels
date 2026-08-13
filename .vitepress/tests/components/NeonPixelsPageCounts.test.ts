import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";

// Prove the three on-page project counts (nav badge, section counter, and the
// "projects live-ish" stat) are derived from PROJECTS rather than hardcoded. We
// mock the data module down to a subset with a different length and different
// zero-padding, then assert each count element renders the mocked count exactly.
// A hardcoded literal would keep rendering the real count and fail here.
// `vi.hoisted` exposes the count to the hoisted `vi.mock` factory.
const { MOCK_PROJECT_COUNT } = vi.hoisted(() => ({ MOCK_PROJECT_COUNT: 3 }));

vi.mock("@theme/data/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@theme/data/projects")>();
  return {
    ...actual,
    PROJECTS: actual.PROJECTS.slice(0, MOCK_PROJECT_COUNT),
  };
});

import NeonPixelsPage from "@components/NeonPixelsPage.vue";

const paddedMockCount = String(MOCK_PROJECT_COUNT).padStart(2, "0");

describe("NeonPixelsPage project counts", () => {
  // Definite-assignment: `beforeEach` always assigns before any test reads it.
  let wrapper!: VueWrapper;

  beforeEach(() => {
    wrapper = mount(NeonPixelsPage);
  });

  afterEach(() => {
    wrapper.unmount();
  });

  it("derives the nav badge count from PROJECTS", () => {
    const navBadge = wrapper.get("header nav span.text-lime");
    expect(navBadge.text().trim()).toBe(`${MOCK_PROJECT_COUNT} projects`);
  });

  it("derives the zero-padded section counter from PROJECTS", () => {
    const counter = wrapper.get("#projects span.text-fg-faint");
    expect(counter.text().trim()).toBe(
      `${paddedMockCount} / ${paddedMockCount}`,
    );
  });

  it("derives the projects stat tile count from PROJECTS", () => {
    const statNumber = wrapper.get("#about .bg-panel span.text-lime");
    expect(statNumber.text().trim()).toBe(String(MOCK_PROJECT_COUNT));
  });
});
