import { describe, it, expect, afterEach, vi } from "vitest";
import { CONSENT_LIFETIME_MS, consentStorageKey } from "@neon-pixels/consent";
import {
  createMemoryStorage,
  stubPrivacySignal,
} from "@neon-pixels/consent/testing";
import {
  CONSENT_APP,
  LEGACY_CONSENT_STORAGE_KEY,
  createSiteConsent,
  getConsentStorage,
  hasStoredChoice,
} from "@theme/analytics/analyticsConsent";
import { GA_MEASUREMENT_ID } from "@theme/analytics/loadGoogleAnalytics";

// Behavior the package tests itself (expiry, malformed records, cookie
// clearing, GPC/DNT variants) is not repeated here: these tests cover this
// site's settings and the storage guard it keeps locally.

const STORAGE_KEY = "neonpixels:analytics-consent";

function storedRecord(choice: string) {
  return JSON.stringify({
    choice,
    expiresAt: Date.now() + CONSENT_LIFETIME_MS,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "_ga=; max-age=0; path=/";
  delete (window as unknown as Record<string, unknown>)[
    `ga-disable-${GA_MEASUREMENT_ID}`
  ];
});

describe("site consent settings", () => {
  it("keeps the storage key returning visitors already have", () => {
    expect(consentStorageKey(CONSENT_APP)).toBe(STORAGE_KEY);
    expect(LEGACY_CONSENT_STORAGE_KEY).toBe("np-analytics-consent");
  });

  it("names only Google Analytics", () => {
    vi.stubGlobal("navigator", stubPrivacySignal());
    const consent = createSiteConsent(createMemoryStorage());
    expect(consent.services).toEqual(["analytics"]);
  });

  it("prompts a first-time visitor and stores a grant under the site key", () => {
    vi.stubGlobal("navigator", stubPrivacySignal());
    const storage = createMemoryStorage();
    const consent = createSiteConsent(storage);
    expect(consent.shouldPrompt).toBe(true);
    consent.grant();
    expect(consent.status).toBe("granted");
    expect(JSON.parse(storage.entries.get(STORAGE_KEY) ?? "{}").choice).toBe(
      "granted",
    );
  });

  it.each([
    ["accepted", "granted"],
    ["declined", "denied"],
  ])(
    "honors a bare %s choice stored under the legacy key and moves it to the site key",
    (legacyValue, expectedStatus) => {
      vi.stubGlobal("navigator", stubPrivacySignal());
      const storage = createMemoryStorage({
        [LEGACY_CONSENT_STORAGE_KEY]: legacyValue,
      });
      const consent = createSiteConsent(storage);
      expect(consent.status).toBe(expectedStatus);
      expect(consent.shouldPrompt).toBe(false);
      expect(storage.entries.has(LEGACY_CONSENT_STORAGE_KEY)).toBe(false);
      expect(storage.entries.has(STORAGE_KEY)).toBe(true);
    },
  );

  it("reads a record in the earlier accepted/declined shape under the site key", () => {
    vi.stubGlobal("navigator", stubPrivacySignal());
    const consent = createSiteConsent(
      createMemoryStorage({ [STORAGE_KEY]: storedRecord("accepted") }),
    );
    expect(consent.status).toBe("granted");
  });

  it.each([
    ["Global Privacy Control", { globalPrivacyControl: true }],
    ["Do Not Track", { doNotTrack: "1" }],
  ])(
    "never prompts or reports a grant for a visitor sending %s",
    (_name, signal) => {
      vi.stubGlobal("navigator", stubPrivacySignal(signal));
      const consent = createSiteConsent(
        createMemoryStorage({ [STORAGE_KEY]: storedRecord("granted") }),
      );
      expect(consent.status).toBe("signal");
      expect(consent.shouldPrompt).toBe(false);
    },
  );

  it("clears the Google Analytics cookies when deny() follows an earlier grant under a privacy signal", () => {
    vi.stubGlobal(
      "navigator",
      stubPrivacySignal({ globalPrivacyControl: true }),
    );
    document.cookie = "_ga=GA1.1.1; path=/";
    const consent = createSiteConsent(
      createMemoryStorage({ [STORAGE_KEY]: storedRecord("granted") }),
    );
    consent.deny();
    expect(document.cookie).not.toContain("_ga=GA1");
    expect(
      (window as unknown as Record<string, unknown>)[
        `ga-disable-${GA_MEASUREMENT_ID}`
      ],
    ).toBe(true);
  });
});

describe("hasStoredChoice", () => {
  it("is false for a visitor who never answered", () => {
    expect(hasStoredChoice(createMemoryStorage())).toBe(false);
  });

  it.each([STORAGE_KEY, LEGACY_CONSENT_STORAGE_KEY])(
    "is true when a value exists under %s",
    (key) => {
      expect(hasStoredChoice(createMemoryStorage({ [key]: "x" }))).toBe(true);
    },
  );
});

describe("getConsentStorage", () => {
  const PROBE_KEY = "np-analytics-consent-probe-test";

  afterEach(() => {
    localStorage.removeItem(PROBE_KEY);
  });

  it("returns the real localStorage when it's usable", () => {
    const storage = getConsentStorage();
    expect(storage).toBe(window.localStorage);
    storage.setItem(PROBE_KEY, "1");
    expect(localStorage.getItem(PROBE_KEY)).toBe("1");
  });

  it("falls back to an in-memory no-op storage when localStorage throws (e.g. Safari 'Block all cookies')", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const blockedStorage: Storage = {
      length: 0,
      key: () => null,
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
      clear: blocked,
    };
    vi.stubGlobal("localStorage", blockedStorage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = getConsentStorage();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(storage).not.toBe(blockedStorage);
      expect(() => storage.setItem(STORAGE_KEY, "granted")).not.toThrow();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });
});
