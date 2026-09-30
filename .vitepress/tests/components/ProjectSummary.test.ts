import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import ProjectSummary from "@components/ProjectSummary.vue";
import { PROJECTS, type Project } from "@theme/data/projects";

// The CTA click handler delegates the actual GA4 event push to
// loadGoogleAnalytics.ts (covered on its own in loadGoogleAnalytics.test.ts)
// and consults analyticsConsent.ts the same way ConsentBanner.vue does —
// mocked here so these tests assert only "did the CTA decide to track,
// gated on consent", never a real dataLayer push or real
// localStorage/navigator state.
const trackGoogleAnalyticsEventMock = vi.fn();
vi.mock("@theme/analytics/loadGoogleAnalytics", () => ({
  trackGoogleAnalyticsEvent: (...args: unknown[]) =>
    trackGoogleAnalyticsEventMock(...args),
}));

// A stable sentinel (not a fresh `{}` per call) so tests can assert the
// handler forwards this exact storage object to shouldLoadAnalytics, rather
// than merely calling the mock at all.
const consentStorageSentinel = {};
const shouldLoadAnalyticsMock = vi.fn();
vi.mock("@theme/analytics/analyticsConsent", () => ({
  getConsentStorage: () => consentStorageSentinel,
  shouldLoadAnalytics: (...args: unknown[]) => shouldLoadAnalyticsMock(...args),
}));

// Build fixtures off a real project so the shape stays honest, but pin the
// variant/flicker flags here rather than mining PROJECTS by variant — that way
// these tests don't quietly break if every project ships as "fill" one day.
const baseProject: Project = { ...PROJECTS[0] };
const filledProject: Project = {
  ...baseProject,
  variant: "fill",
  flickerTld: true,
};
const outlineProject: Project = {
  ...baseProject,
  variant: "outline",
  flickerTld: false,
};

describe("ProjectSummary", () => {
  beforeEach(() => {
    shouldLoadAnalyticsMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders correctly", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(wrapper.html()).toMatchSnapshot();
    wrapper.unmount();
  });

  it("renders the project's status, order, category and copy", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    const text = wrapper.text();
    expect(text).toContain(outlineProject.status);
    expect(text).toContain(outlineProject.order);
    expect(text).toContain(outlineProject.category);
    expect(text).toContain(outlineProject.description);
    wrapper.unmount();
  });

  it("renders the name and tld with no gap so the wordmark reads as one", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    const heading = wrapper.find("h3").text();
    expect(heading).toBe(`${filledProject.name}${filledProject.tld}`);
    wrapper.unmount();
  });

  it("links the CTA to the external site and opens it safely", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    const cta = wrapper.find("a");
    expect(cta.attributes("href")).toBe(filledProject.url);
    expect(cta.attributes("target")).toBe("_blank");
    const relTokens = (cta.attributes("rel") ?? "").split(/\s+/);
    expect(relTokens).toContain("noopener");
    expect(relTokens).toContain("noreferrer");
    wrapper.unmount();
  });

  it("gives a fill variant a solid badge and CTA", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(wrapper.find("a").classes()).toContain("cta-fill");
    expect(wrapper.find("span").classes()).toContain(filledProject.accent.bg);
    wrapper.unmount();
  });

  it("gives an outline variant a bordered badge and CTA", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    const cta = wrapper.find("a");
    expect(cta.classes()).toContain("cta-outline");
    expect(cta.classes()).toContain(outlineProject.accent.border);
    wrapper.unmount();
  });

  it("exposes the project color to the outline hover via --accent", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    // --accent is the only thing driving .cta-outline:hover's background.
    const style = wrapper.find("a").attributes("style") ?? "";
    expect(style).toContain(`--accent: ${outlineProject.color}`);
    wrapper.unmount();
  });

  it("keeps the heading clamp and paragraph text-wrap in the rendered markup", async () => {
    // happy-dom's CSSOM drops clamp()/text-wrap, so the client snapshots can't
    // catch their removal. Server-render the raw markup, which preserves the
    // authored inline style verbatim, and assert on that instead.
    const html = await renderToString(
      createSSRApp({
        render: () => h(ProjectSummary, { project: filledProject }),
      }),
    );
    expect(html).toContain("font-size:clamp(38px, 5vw, 66px)");
    expect(html).toContain("text-wrap:pretty");
  });

  it("derives the fill hover glow from the project color, not a fixed lime", () => {
    const tealFill: Project = {
      ...baseProject,
      color: "#123456",
      variant: "fill",
    };
    const wrapper = mount(ProjectSummary, { props: { project: tealFill } });
    // --accent-glow feeds .cta-fill:hover; it must track the project color so a
    // non-lime fill project doesn't snap to lime on hover.
    const style = wrapper.find("a").attributes("style") ?? "";
    expect(style).toContain("--accent-glow: rgba(18, 52, 86, 0.6)");
    wrapper.unmount();
  });

  it("exposes the project color to the fill CTA via --accent for the focus ring", () => {
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    // The global :focus-visible ring reads --accent; the fill CTA must expose it
    // so its focus ring tracks the project color instead of the lime fallback.
    const style = wrapper.find("a").attributes("style") ?? "";
    expect(style).toContain(`--accent: ${filledProject.color}`);
    wrapper.unmount();
  });

  it("flickers the tld only when the project asks for it", () => {
    const flickerWrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    expect(flickerWrapper.find("h3 span").classes()).toContain(
      "animate-flicker",
    );
    flickerWrapper.unmount();

    const steadyWrapper = mount(ProjectSummary, {
      props: { project: outlineProject },
    });
    expect(steadyWrapper.find("h3 span").classes()).not.toContain(
      "animate-flicker",
    );
    steadyWrapper.unmount();
  });

  it("fires an outbound_click GA4 event with the project name and destination when consent is granted", async () => {
    shouldLoadAnalyticsMock.mockReturnValue(true);
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    await wrapper.find("a").trigger("click");
    expect(shouldLoadAnalyticsMock).toHaveBeenCalledWith(
      navigator,
      consentStorageSentinel,
    );
    expect(trackGoogleAnalyticsEventMock).toHaveBeenCalledTimes(1);
    expect(trackGoogleAnalyticsEventMock).toHaveBeenCalledWith(
      "outbound_click",
      {
        project_name: filledProject.name,
        destination_url: filledProject.url,
      },
    );
    wrapper.unmount();
  });

  it("fires no GA4 event when consent has not been granted", async () => {
    shouldLoadAnalyticsMock.mockReturnValue(false);
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    await wrapper.find("a").trigger("click");
    // Proves the click actually consulted (and was blocked by) the consent
    // gate, not merely that no event fired for some unrelated reason (e.g. a
    // missing `@click` binding).
    expect(shouldLoadAnalyticsMock).toHaveBeenCalledWith(
      navigator,
      consentStorageSentinel,
    );
    expect(trackGoogleAnalyticsEventMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("also tracks a middle-click, which opens a new tab via auxclick rather than click", async () => {
    shouldLoadAnalyticsMock.mockReturnValue(true);
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    await wrapper.find("a").trigger("auxclick", { button: 1 });
    expect(trackGoogleAnalyticsEventMock).toHaveBeenCalledTimes(1);
    expect(trackGoogleAnalyticsEventMock).toHaveBeenCalledWith(
      "outbound_click",
      {
        project_name: filledProject.name,
        destination_url: filledProject.url,
      },
    );
    wrapper.unmount();
  });

  it("ignores a right-click auxclick (context menu), which reports a different button", async () => {
    shouldLoadAnalyticsMock.mockReturnValue(true);
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    await wrapper.find("a").trigger("auxclick", { button: 2 });
    expect(trackGoogleAnalyticsEventMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not prevent the CTA's own navigation when tracking the click", async () => {
    shouldLoadAnalyticsMock.mockReturnValue(true);
    const wrapper = mount(ProjectSummary, {
      props: { project: filledProject },
    });
    const anchorElement = wrapper.find("a").element;
    // trigger() dispatches a real DOM event but doesn't hand the event object
    // back, so capture it directly to assert the handler never calls
    // preventDefault — a happy-dom anchor with no real page to load won't
    // navigate, so defaultPrevented is the only observable proxy for "the
    // link would still navigate normally".
    let capturedEvent: Event | undefined;
    anchorElement.addEventListener("click", (event) => {
      capturedEvent = event;
    });
    await wrapper.find("a").trigger("click");
    expect(capturedEvent?.defaultPrevented).toBe(false);
    wrapper.unmount();
  });
});
