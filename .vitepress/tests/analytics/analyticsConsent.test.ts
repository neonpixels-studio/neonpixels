import { describe, it, expect } from "vitest";
import {
  CONSENT_CHOICES,
  CONSENT_STORAGE_KEY,
  getStoredConsentChoice,
  setStoredConsentChoice,
  shouldLoadAnalytics,
  shouldPromptForConsent,
  trackingSignalPresent,
  type ConsentStorage,
  type TrackingSignalSource,
} from "@theme/analytics/analyticsConsent";

// A plain in-memory Map-backed fake rather than the real localStorage/happy-dom
// global: keeps these tests independent of DOM setup and free to assert on
// exactly the two operations this module actually performs.
function createFakeStorage(initial?: Record<string, string>): ConsentStorage {
  const backing = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
}

function createNavigatorFixture(
  overrides: Partial<TrackingSignalSource> = {},
): TrackingSignalSource {
  return { doNotTrack: null, globalPrivacyControl: false, ...overrides };
}

describe("trackingSignalPresent", () => {
  it("is false when neither Do Not Track nor Global Privacy Control is set", () => {
    expect(trackingSignalPresent(createNavigatorFixture())).toBe(false);
  });

  it("is true for the standard Do Not Track value '1'", () => {
    expect(
      trackingSignalPresent(createNavigatorFixture({ doNotTrack: "1" })),
    ).toBe(true);
  });

  it("is true for the legacy Do Not Track value 'yes'", () => {
    expect(
      trackingSignalPresent(createNavigatorFixture({ doNotTrack: "yes" })),
    ).toBe(true);
  });

  it("is false for Do Not Track explicitly unset ('0' or 'unspecified')", () => {
    expect(
      trackingSignalPresent(createNavigatorFixture({ doNotTrack: "0" })),
    ).toBe(false);
    expect(
      trackingSignalPresent(
        createNavigatorFixture({ doNotTrack: "unspecified" }),
      ),
    ).toBe(false);
  });

  it("is true when Global Privacy Control is set", () => {
    expect(
      trackingSignalPresent(
        createNavigatorFixture({ globalPrivacyControl: true }),
      ),
    ).toBe(true);
  });
});

describe("stored consent choice", () => {
  it("returns null when no choice has ever been stored", () => {
    expect(getStoredConsentChoice(createFakeStorage())).toBeNull();
  });

  it("returns null for a corrupted/unrecognized stored value", () => {
    const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: "maybe" });
    expect(getStoredConsentChoice(storage)).toBeNull();
  });

  it("round-trips an accepted choice", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.accepted);
    expect(getStoredConsentChoice(storage)).toBe(CONSENT_CHOICES.accepted);
  });

  it("round-trips a declined choice", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.declined);
    expect(getStoredConsentChoice(storage)).toBe(CONSENT_CHOICES.declined);
  });
});

describe("shouldLoadAnalytics", () => {
  it("is false when Do Not Track is set, even with a stored acceptance", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    const navigatorFixture = createNavigatorFixture({ doNotTrack: "1" });
    expect(shouldLoadAnalytics(navigatorFixture, storage)).toBe(false);
  });

  it("is false when Global Privacy Control is set, even with a stored acceptance", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    const navigatorFixture = createNavigatorFixture({
      globalPrivacyControl: true,
    });
    expect(shouldLoadAnalytics(navigatorFixture, storage)).toBe(false);
  });

  it("is false when neither signal is set but no choice has been stored", () => {
    expect(
      shouldLoadAnalytics(createNavigatorFixture(), createFakeStorage()),
    ).toBe(false);
  });

  it("is false when neither signal is set and the stored choice is declined", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.declined,
    });
    expect(shouldLoadAnalytics(createNavigatorFixture(), storage)).toBe(false);
  });

  it("is true only when neither signal is set and consent was accepted", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    expect(shouldLoadAnalytics(createNavigatorFixture(), storage)).toBe(true);
  });
});

describe("shouldPromptForConsent", () => {
  it("is false when Do Not Track is set — the signal already answered the question", () => {
    const navigatorFixture = createNavigatorFixture({ doNotTrack: "1" });
    expect(shouldPromptForConsent(navigatorFixture, createFakeStorage())).toBe(
      false,
    );
  });

  it("is false when Global Privacy Control is set", () => {
    const navigatorFixture = createNavigatorFixture({
      globalPrivacyControl: true,
    });
    expect(shouldPromptForConsent(navigatorFixture, createFakeStorage())).toBe(
      false,
    );
  });

  it("is true when no signal is set and no choice has been stored yet", () => {
    expect(
      shouldPromptForConsent(createNavigatorFixture(), createFakeStorage()),
    ).toBe(true);
  });

  it("is false once a choice has already been stored, accepted or declined", () => {
    const acceptedStorage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    const declinedStorage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: CONSENT_CHOICES.declined,
    });
    expect(
      shouldPromptForConsent(createNavigatorFixture(), acceptedStorage),
    ).toBe(false);
    expect(
      shouldPromptForConsent(createNavigatorFixture(), declinedStorage),
    ).toBe(false);
  });
});
