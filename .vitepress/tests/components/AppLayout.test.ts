import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

const pageState = vi.hoisted(() => ({ isNotFound: false }));

vi.mock("vitepress", async () => {
  const { computed } = await import("vue");
  return {
    useData: () => ({
      page: computed(() => ({ isNotFound: pageState.isNotFound })),
    }),
  };
});

import AppLayout from "@theme/AppLayout.vue";

describe("AppLayout", () => {
  it("renders the homepage for a valid route", () => {
    pageState.isNotFound = false;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      true,
    );
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the 404 view when the page is not found", () => {
    pageState.isNotFound = true;
    const wrapper = shallowMount(AppLayout);
    expect(wrapper.findComponent({ name: "NotFound" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "NeonPixelsPage" }).exists()).toBe(
      false,
    );
    wrapper.unmount();
  });
});
