import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import NotFound from "@components/NotFound.vue";

// Matches any absolute URL (has a scheme, e.g. "https:", "mailto:") or a
// protocol-relative URL ("//host/..."). Matching by scheme presence rather
// than hardcoding http(s) means a mailto:/tel:/ftp: link is correctly
// treated as external instead of silently falling into "internal".
const EXTERNAL_HREF_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function isExternalHref(href: string) {
  return EXTERNAL_HREF_PATTERN.test(href);
}

describe("NotFound", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders correctly", async () => {
    const wrapper = shallowMount(NotFound);
    await wrapper.vm.$nextTick();
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("renders the 404 heading", async () => {
    const wrapper = shallowMount(NotFound);
    await wrapper.vm.$nextTick();
    expect(wrapper.find("h1").text()).toBe("404");
    wrapper.unmount();
  });

  it("shows the requested path in the terminal trace", async () => {
    const path = "/does-not-exist";
    window.history.replaceState({}, "", path);

    const wrapper = shallowMount(NotFound);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain(path);
    wrapper.unmount();
  });

  it("links back to the homepage", async () => {
    const wrapper = shallowMount(NotFound);
    await wrapper.vm.$nextTick();
    const homeLink = wrapper.find('a[href="/"]');
    expect(homeLink.exists()).toBe(true);
    wrapper.unmount();
  });

  it("opens every external link rendered in this template safely in a new tab", async () => {
    const wrapper = shallowMount(NotFound);
    await wrapper.vm.$nextTick();
    const allLinks = wrapper.findAll("a[href]");
    const externalLinks = allLinks.filter((link) =>
      isExternalHref(link.attributes("href") ?? ""),
    );
    const internalLinks = allLinks.filter(
      (link) => !isExternalHref(link.attributes("href") ?? ""),
    );
    // Pinned to the one known external link (grimicorn.dev) so deleting it
    // silently drops out of coverage instead of still passing.
    expect(externalLinks).toHaveLength(1);
    expect(internalLinks.length).toBeGreaterThan(0);
    externalLinks.forEach((externalLink) => {
      expect(externalLink.attributes("target")).toBe("_blank");
      const relTokens = (externalLink.attributes("rel") ?? "").split(/\s+/);
      expect(relTokens).toContain("noopener");
      expect(relTokens).toContain("noreferrer");
    });
    internalLinks.forEach((internalLink) => {
      expect(internalLink.attributes("target")).toBeUndefined();
    });
    wrapper.unmount();
  });
});
