import { describe, it, expect } from "vitest";
import { shallowMount } from "@vue/test-utils";
import PrivacyPolicy from "@components/PrivacyPolicy.vue";
import { MAIN_CONTENT_ID } from "@theme/a11y";
import { GA_MEASUREMENT_ID } from "@theme/analytics/loadGoogleAnalytics";

describe("PrivacyPolicy", () => {
  it("renders correctly", () => {
    const wrapper = shallowMount(PrivacyPolicy);
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("exposes a single main landmark for the skip link to target", () => {
    // Same bypass-blocks contract as the homepage and 404 views (WCAG 2.4.1):
    // exactly one <main>, carrying the shared content id and tabindex="-1".
    const wrapper = shallowMount(PrivacyPolicy);
    const landmarks = wrapper.findAll("main");
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0].attributes("id")).toBe(MAIN_CONTENT_ID);
    expect(landmarks[0].attributes("tabindex")).toBe("-1");
    wrapper.unmount();
  });

  it("renders the privacy policy heading", () => {
    const wrapper = shallowMount(PrivacyPolicy);
    expect(wrapper.find("h1").text()).toBe("Privacy Policy");
    wrapper.unmount();
  });

  it("describes what GA4 collects, why, and for how long", () => {
    // Loose content assertions (not an exact-copy pin) so future wording
    // tweaks don't need to touch this test - but the acceptance criteria this
    // page exists to satisfy (issue #149) is that it actually says these
    // things, not merely that a page exists.
    const wrapper = shallowMount(PrivacyPolicy);
    const text = wrapper.text();
    expect(text).toContain("Google Analytics");
    expect(text).toMatch(/pageview/i);
    expect(text).toMatch(/event/i);
    expect(text).toContain("14 months");
    expect(text).toContain(GA_MEASUREMENT_ID);
    wrapper.unmount();
  });

  it("links back to the homepage", () => {
    const wrapper = shallowMount(PrivacyPolicy);
    const homeLinks = wrapper.findAll('a[href="/"]');
    expect(homeLinks.length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
