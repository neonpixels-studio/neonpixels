import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ConsentBanner from "@components/ConsentBanner.vue";
import { CONSENT_STORAGE_KEY } from "@theme/analytics/analyticsConsent";

// The banner delegates the actual GA4 bootstrap/kill-switch to
// loadGoogleAnalytics.ts (covered on its own in loadGoogleAnalytics.test.ts)
// — mocked here so these tests assert only "did the banner decide to load or
// disable analytics", never a real script tag landing in the test DOM.
const loadGoogleAnalyticsMock = vi.fn();
const disableGoogleAnalyticsMock = vi.fn();
vi.mock("@theme/analytics/loadGoogleAnalytics", () => ({
  GA_MEASUREMENT_ID: "G-TEST123",
  loadGoogleAnalytics: (...args: unknown[]) => loadGoogleAnalyticsMock(...args),
  disableGoogleAnalytics: (...args: unknown[]) =>
    disableGoogleAnalyticsMock(...args),
}));

const BANNER_SELECTOR = '[role="region"]';
const MANAGE_CHOICE_TEXT = "Analytics choice";

function setDoNotTrack(value: string | null) {
  Object.defineProperty(navigator, "doNotTrack", {
    value,
    configurable: true,
  });
}

function setGlobalPrivacyControl(value: boolean | undefined) {
  Object.defineProperty(navigator, "globalPrivacyControl", {
    value,
    configurable: true,
  });
}

describe("ConsentBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    setDoNotTrack(null);
    setGlobalPrivacyControl(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("does not initialize analytics or show the banner when Do Not Track is set", async () => {
    setDoNotTrack("1");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not initialize analytics or show the banner when Global Privacy Control is set", async () => {
    setGlobalPrivacyControl(true);
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not initialize analytics up front, and prompts for consent, when neither signal is set and no choice is stored", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(true);
    wrapper.unmount();
  });

  it("initializes analytics immediately, with no banner, when consent was already accepted", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledWith("G-TEST123");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("stays hidden, with no banner shown again, when consent was already declined", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "declined");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("initializes analytics, stores the choice, and hides the banner when Accept is clicked", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const acceptButton = wrapper.findAll("button")[0];
    expect(acceptButton.text()).toBe("Accept");
    await acceptButton.trigger("click");
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe("accepted");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("never initializes analytics, but stores the choice and hides the banner, when Decline is clicked", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const declineButton = wrapper.findAll("button")[1];
    expect(declineButton.text()).toBe("Decline");
    await declineButton.trigger("click");
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    // Nothing was ever loaded this session, so there is nothing to disable.
    expect(disableGoogleAnalyticsMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe("declined");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers a manage-choice control instead of the banner once a choice is already stored", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    expect(manageButton).toBeDefined();
    wrapper.unmount();
  });

  it("offers no manage-choice control when Do Not Track overrides a stale stored acceptance", async () => {
    setDoNotTrack("1");
    localStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    expect(manageButton).toBeUndefined();
    wrapper.unmount();
  });

  it("reopens the accept/decline banner when the manage-choice control is clicked", async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, "declined");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    await manageButton?.trigger("click");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(true);
    expect(
      wrapper.findAll("button").find((button) => button.text() === "Accept"),
    ).toBeDefined();
    wrapper.unmount();
  });

  it("disables analytics (rather than requiring a reload) when consent is revoked after being active this session", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click"); // Accept
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(1);

    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    await manageButton?.trigger("click");
    const declineButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "Decline");
    await declineButton?.trigger("click");

    expect(disableGoogleAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(disableGoogleAnalyticsMock).toHaveBeenCalledWith("G-TEST123");
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe("declined");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });
});
