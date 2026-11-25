import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ConsentBanner from "@components/ConsentBanner.vue";
import { CONSENT_LIFETIME_MS, consentStorageKey } from "@neon-pixels/consent";
import { stubPrivacySignal } from "@neon-pixels/consent/testing";
import {
  CONSENT_APP,
  MANAGE_CHOICE_LABEL,
} from "@theme/analytics/analyticsConsent";
import { GA_MEASUREMENT_ID } from "@theme/analytics/loadGoogleAnalytics";
import { PRIVACY_POLICY_URL } from "@theme/routes";

type StoredChoice = "granted" | "denied";

// Only the gtag.js loader is replaced, so these tests assert "did the banner
// decide to load analytics" without a real script tag landing in the test
// DOM. The consent state, kill switch, and cookie clearing are the real
// package code.
const loadGoogleAnalyticsMock = vi.fn();
vi.mock("@neon-pixels/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@neon-pixels/consent")>()),
  loadGoogleAnalytics: (...args: unknown[]) => loadGoogleAnalyticsMock(...args),
}));

const STORAGE_KEY = consentStorageKey(CONSENT_APP);
const DISABLE_FLAG = `ga-disable-${GA_MEASUREMENT_ID}`;

const BANNER_SELECTOR = '[role="region"]';
// Imported (not hand-typed) so every assertion below that matches on this
// text also proves the rendered button still reads MANAGE_CHOICE_LABEL - the
// same constant PrivacyPolicy.vue points visitors at - rather than a second,
// independently-drifting copy of the string.
const MANAGE_CHOICE_TEXT = MANAGE_CHOICE_LABEL;

function stubSignals(signals: Parameters<typeof stubPrivacySignal>[0] = {}) {
  vi.stubGlobal("navigator", stubPrivacySignal(signals));
}

function storeChoice(choice: StoredChoice, now = Date.now()) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ choice, expiresAt: now + CONSENT_LIFETIME_MS }),
  );
}

function readStoredChoice() {
  const rawValue = localStorage.getItem(STORAGE_KEY);
  return rawValue === null ? null : JSON.parse(rawValue).choice;
}

function windowFlags() {
  return window as unknown as Record<string, unknown>;
}

describe("ConsentBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    stubSignals();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.cookie = "_ga=; max-age=0; path=/";
    delete windowFlags()[DISABLE_FLAG];
  });

  it("does not initialize analytics or show the banner when Do Not Track is set", async () => {
    stubSignals({ doNotTrack: "1" });
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not initialize analytics or show the banner when Global Privacy Control is set", async () => {
    stubSignals({ globalPrivacyControl: true });
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

  // Issue #149: the banner names Google Analytics but must actually link to
  // something describing what's collected/retained, not just say the name.
  it("links to the privacy policy from the banner text", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const privacyLink = wrapper
      .findAll("a")
      .find((link) => link.text() === "Privacy policy");
    expect(privacyLink).toBeDefined();
    expect(privacyLink?.attributes("href")).toBe(PRIVACY_POLICY_URL);
    wrapper.unmount();
  });

  it("initializes analytics immediately, with no banner, when consent was already accepted", async () => {
    storeChoice("granted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledWith(GA_MEASUREMENT_ID, {
      document,
      window,
    });
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("prompts again, without loading analytics, when the stored acceptance has expired", async () => {
    storeChoice("granted", Date.now() - CONSENT_LIFETIME_MS - 1);
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(true);
    expect(loadGoogleAnalyticsMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("stays hidden, with no banner shown again, when consent was already declined", async () => {
    storeChoice("denied");
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
    expect(readStoredChoice()).toBe("granted");
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
    expect(readStoredChoice()).toBe("denied");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers a manage-choice control instead of the banner once a choice is already stored", async () => {
    storeChoice("granted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    expect(manageButton).toBeDefined();
    wrapper.unmount();
  });

  it("offers no manage-choice control when Do Not Track overrides a stale stored acceptance", async () => {
    stubSignals({ doNotTrack: "1" });
    storeChoice("granted");
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
    storeChoice("denied");
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
    document.cookie = "_ga=GA1.1.1; path=/";
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

    expect(windowFlags()[DISABLE_FLAG]).toBe(true);
    // Revoking must also purge GA4's own identifier cookies, not just stop
    // future hits.
    expect(document.cookie).not.toContain("_ga=GA1");
    expect(readStoredChoice()).toBe("denied");
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    wrapper.unmount();
  });

  it("loads analytics again when re-accepting after a decline in the same session", async () => {
    // The package's loader is idempotent and clears the kill switch itself;
    // the banner just has to call it again on every grant.
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click"); // Accept

    const manageButtonAfterAccept = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    await manageButtonAfterAccept?.trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Decline")
      ?.trigger("click");

    const manageButtonAfterDecline = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    await manageButtonAfterDecline?.trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Accept")
      ?.trigger("click");

    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(2);
    expect(readStoredChoice()).toBe("granted");
    wrapper.unmount();
  });

  it("names only the configured service in the banner text", async () => {
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(BANNER_SELECTOR).text()).toContain(
      "This site uses Google Analytics to see which pages get read.",
    );
    wrapper.unmount();
  });

  it("still honors a choice stored under the legacy key", async () => {
    localStorage.setItem("np-analytics-consent", "accepted");
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(loadGoogleAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(BANNER_SELECTOR).exists()).toBe(false);
    expect(readStoredChoice()).toBe("granted");
    wrapper.unmount();
  });

  it("denies, and clears the GA cookies of, a visitor who granted earlier and now sends a privacy signal", async () => {
    stubSignals({ globalPrivacyControl: true });
    storeChoice("granted");
    document.cookie = "_ga=GA1.1.1; path=/";
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(document.cookie).not.toContain("_ga=GA1");
    expect(windowFlags()[DISABLE_FLAG]).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toContain('"denied"');
    wrapper.unmount();
  });

  it("records no choice for a visitor with a privacy signal who never answered", async () => {
    stubSignals({ doNotTrack: "1" });
    const wrapper = mount(ConsentBanner);
    await wrapper.vm.$nextTick();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    wrapper.unmount();
  });

  it("moves focus to the manage-choice control after a decision hides the banner", async () => {
    const wrapper = mount(ConsentBanner, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    await wrapper.findAll("button")[0].trigger("click"); // Accept
    await wrapper.vm.$nextTick();
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    expect(manageButton).toBeDefined();
    expect(document.activeElement).toBe(manageButton?.element);
    wrapper.unmount();
  });

  it("moves focus to the Accept button when the manage-choice control reopens the banner", async () => {
    storeChoice("denied");
    const wrapper = mount(ConsentBanner, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    const manageButton = wrapper
      .findAll("button")
      .find((button) => button.text() === MANAGE_CHOICE_TEXT);
    await manageButton?.trigger("click");
    await wrapper.vm.$nextTick();
    const acceptButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "Accept");
    expect(acceptButton).toBeDefined();
    expect(document.activeElement).toBe(acceptButton?.element);
    wrapper.unmount();
  });
});
