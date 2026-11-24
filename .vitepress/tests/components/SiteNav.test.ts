import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import SiteNav from "@components/SiteNav.vue";

const MENU_TOGGLE_SELECTOR = 'button[aria-controls="mobile-menu"]';
const MOBILE_MENU_SELECTOR = "#mobile-menu";
const IN_PAGE_HREFS = ["#projects", "#about", "#contact"];

enableAutoUnmount(afterEach);

function mountNav() {
  return mount(SiteNav, { attachTo: document.body });
}

describe("SiteNav mobile menu", () => {
  it("starts closed with the panel out of the DOM", () => {
    const wrapper = mountNav();
    const toggle = wrapper.get(MENU_TOGGLE_SELECTOR);
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.text()).toBe("menu");
    expect(wrapper.find(MOBILE_MENU_SELECTOR).exists()).toBe(false);
  });

  it("opens the panel with every in-page link when the toggle is pressed", async () => {
    const wrapper = mountNav();
    const toggle = wrapper.get(MENU_TOGGLE_SELECTOR);
    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(toggle.text()).toBe("close");
    const panelHrefs = wrapper
      .get(MOBILE_MENU_SELECTOR)
      .findAll("ul > li > a")
      .map((link) => link.attributes("href"));
    expect(panelHrefs).toEqual(IN_PAGE_HREFS);
  });

  it("closes again on a second toggle press", async () => {
    const wrapper = mountNav();
    const toggle = wrapper.get(MENU_TOGGLE_SELECTOR);
    await toggle.trigger("click");
    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(MOBILE_MENU_SELECTOR).exists()).toBe(false);
  });

  it("closes after a panel link is followed", async () => {
    const wrapper = mountNav();
    await wrapper.get(MENU_TOGGLE_SELECTOR).trigger("click");
    await wrapper
      .get(`${MOBILE_MENU_SELECTOR} a[href="#about"]`)
      .trigger("click");

    expect(wrapper.find(MOBILE_MENU_SELECTOR).exists()).toBe(false);
  });

  it("closes on Escape and returns focus to the toggle", async () => {
    const wrapper = mountNav();
    await wrapper.get(MENU_TOGGLE_SELECTOR).trigger("click");
    const panelLink = wrapper.get(`${MOBILE_MENU_SELECTOR} a`);
    (panelLink.element as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find(MOBILE_MENU_SELECTOR).exists()).toBe(false);
    expect(document.activeElement).toBe(
      wrapper.get(MENU_TOGGLE_SELECTOR).element,
    );
  });

  it("keeps the desktop links visible only from the md breakpoint up", () => {
    const wrapper = mountNav();
    const desktopLinks = wrapper.findAll("nav > a");
    expect(desktopLinks.map((link) => link.attributes("href"))).toEqual(
      IN_PAGE_HREFS,
    );
    for (const link of desktopLinks) {
      expect(link.classes()).toEqual(
        expect.arrayContaining(["hidden", "md:inline"]),
      );
    }
    expect(wrapper.get(MENU_TOGGLE_SELECTOR).classes()).toContain("md:hidden");
  });
});
