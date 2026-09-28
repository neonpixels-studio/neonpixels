import { describe, it, expect } from "vitest";
import { shallowMount } from "@vue/test-utils";
import PrivacyPolicy from "@components/PrivacyPolicy.vue";
import { MAIN_CONTENT_ID } from "@theme/a11y";
import { GA_MEASUREMENT_ID } from "@theme/analytics/loadGoogleAnalytics";
import { MANAGE_CHOICE_LABEL } from "@theme/analytics/analyticsConsent";

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
    expect(text).toContain("Pageviews");
    expect(text).toContain("Interaction events");
    expect(text).toContain("14 months");
    expect(text).toContain(GA_MEASUREMENT_ID);
    wrapper.unmount();
  });

  it("discloses the GA4 cookies loadGoogleAnalytics.ts actually sets", () => {
    // Round-3 review finding: loadGoogleAnalyticsCookies.ts's own
    // clearGoogleAnalyticsCookies() already knows _ga/_ga_* exist (it clears
    // them on decline) - this page must actually disclose them too, not just
    // the pageview/event data GA4 sends over the wire.
    const wrapper = shallowMount(PrivacyPolicy);
    const text = wrapper.text();
    expect(text).toContain("_ga");
    expect(text).toMatch(/2 years/);
    wrapper.unmount();
  });

  it("points the manage-choice instruction at the banner's real control label", () => {
    // Regression coverage for the round-2 review finding: this page tells a
    // visitor to look for a control by name, so it must read the same
    // MANAGE_CHOICE_LABEL ConsentBanner.vue's button actually renders, not an
    // independently hand-typed copy the two could drift apart from.
    const wrapper = shallowMount(PrivacyPolicy);
    expect(wrapper.text()).toContain(MANAGE_CHOICE_LABEL);
    wrapper.unmount();
  });

  it("links out to Google's own privacy policy safely in a new tab", () => {
    const wrapper = shallowMount(PrivacyPolicy);
    const googleLink = wrapper.find(
      'a[href="https://policies.google.com/privacy"]',
    );
    expect(googleLink.exists()).toBe(true);
    expect(googleLink.attributes("target")).toBe("_blank");
    const relTokens = (googleLink.attributes("rel") ?? "").split(/\s+/);
    expect(relTokens).toContain("noopener");
    expect(relTokens).toContain("noreferrer");
    wrapper.unmount();
  });

  it("links back to the homepage", () => {
    const wrapper = shallowMount(PrivacyPolicy);
    const homeLinks = wrapper.findAll('a[href="/"]');
    expect(homeLinks.length).toBeGreaterThan(0);
    wrapper.unmount();
  });
});
