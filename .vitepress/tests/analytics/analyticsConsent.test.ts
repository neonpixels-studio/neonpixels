import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CONSENT_CHOICES,
  CONSENT_LIFETIME_MS,
  CONSENT_STORAGE_KEY,
  LEGACY_CONSENT_STORAGE_KEY,
  getConsentStorage,
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
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

const NOW = 1_800_000_000_000;

function storedRecord(choice: string, expiresAt = NOW + CONSENT_LIFETIME_MS) {
  return JSON.stringify({ choice, expiresAt });
}

function createNavigatorFixture(
  overrides: Partial<TrackingSignalSource> = {},
): TrackingSignalSource {
  return { doNotTrack: null, globalPrivacyControl: false, ...overrides };
}

// Relative to the real clock, for tests that go through shouldLoadAnalytics
// and shouldPromptForConsent, which read Date.now() themselves.
function unexpiredRecord(choice: string) {
  return storedRecord(choice, Date.now() + CONSENT_LIFETIME_MS);
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
    expect(getStoredConsentChoice(createFakeStorage(), NOW)).toBeNull();
  });

  it.each([
    ["an unrecognized bare string", "maybe"],
    ["invalid JSON", "{nope"],
    ["JSON null", "null"],
    ["an unknown choice", storedRecord("maybe")],
    [
      "a non-numeric expiry",
      JSON.stringify({ choice: "accepted", expiresAt: "soon" }),
    ],
    ["a missing expiry", JSON.stringify({ choice: "accepted" })],
  ])("returns null for %s", (_label, value) => {
    const storage = createFakeStorage({ [CONSENT_STORAGE_KEY]: value });
    expect(getStoredConsentChoice(storage, NOW)).toBeNull();
  });

  it("round-trips an accepted choice (accept)", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.accepted, NOW);
    expect(getStoredConsentChoice(storage, NOW)).toBe(CONSENT_CHOICES.accepted);
  });

  it("round-trips a declined choice (decline)", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.declined, NOW);
    expect(getStoredConsentChoice(storage, NOW)).toBe(CONSENT_CHOICES.declined);
  });

  it("stores { choice, expiresAt } expiring 180 days out", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.accepted, NOW);
    expect(JSON.parse(storage.getItem(CONSENT_STORAGE_KEY) ?? "")).toEqual({
      choice: "accepted",
      expiresAt: NOW + 180 * 24 * 60 * 60 * 1000,
    });
  });

  it("replaces an accepted choice when consent is withdrawn", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.accepted, NOW);
    setStoredConsentChoice(storage, CONSENT_CHOICES.declined, NOW + 1000);
    expect(getStoredConsentChoice(storage, NOW + 2000)).toBe(
      CONSENT_CHOICES.declined,
    );
  });

  it("is still valid one millisecond before expiry and gone at expiry", () => {
    const storage = createFakeStorage();
    setStoredConsentChoice(storage, CONSENT_CHOICES.accepted, NOW);
    const expiresAt = NOW + CONSENT_LIFETIME_MS;
    expect(getStoredConsentChoice(storage, expiresAt - 1)).toBe(
      CONSENT_CHOICES.accepted,
    );
    expect(getStoredConsentChoice(storage, expiresAt)).toBeNull();
  });

  it("treats an expired choice as no choice", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: storedRecord(CONSENT_CHOICES.accepted, NOW - 1),
    });
    expect(getStoredConsentChoice(storage, NOW)).toBeNull();
  });

  it("does not load analytics or hide the banner for an expired acceptance", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: storedRecord(
        CONSENT_CHOICES.accepted,
        Date.now() - 1,
      ),
    });
    expect(shouldLoadAnalytics(createNavigatorFixture(), storage)).toBe(false);
    expect(shouldPromptForConsent(createNavigatorFixture(), storage)).toBe(
      true,
    );
  });

  it.each([CONSENT_CHOICES.accepted, CONSENT_CHOICES.declined])(
    "migrates a legacy %s value, restarting the 180 days and removing the old key",
    (choice) => {
      const storage = createFakeStorage({
        [LEGACY_CONSENT_STORAGE_KEY]: choice,
      });
      expect(getStoredConsentChoice(storage, NOW)).toBe(choice);
      expect(storage.getItem(LEGACY_CONSENT_STORAGE_KEY)).toBeNull();
      expect(JSON.parse(storage.getItem(CONSENT_STORAGE_KEY) ?? "")).toEqual({
        choice,
        expiresAt: NOW + CONSENT_LIFETIME_MS,
      });
    },
  );

  it("drops an unrecognized legacy value without recording a choice", () => {
    const storage = createFakeStorage({
      [LEGACY_CONSENT_STORAGE_KEY]: "maybe",
    });
    expect(getStoredConsentChoice(storage, NOW)).toBeNull();
    expect(storage.getItem(LEGACY_CONSENT_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
  });

  it("keeps the legacy key and still honors the choice when the migration write fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = new Map([[LEGACY_CONSENT_STORAGE_KEY, "declined"]]);
    const storage: ConsentStorage = {
      getItem: (key) => backing.get(key) ?? null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: (key) => {
        backing.delete(key);
      },
    };
    expect(getStoredConsentChoice(storage, NOW)).toBe(CONSENT_CHOICES.declined);
    expect(backing.get(LEGACY_CONSENT_STORAGE_KEY)).toBe("declined");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not revive a legacy value when the current key is expired", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: storedRecord(CONSENT_CHOICES.declined, NOW - 1),
      [LEGACY_CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    expect(getStoredConsentChoice(storage, NOW)).toBeNull();
  });

  it("prefers the current key over a legacy value", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: storedRecord(CONSENT_CHOICES.declined),
      [LEGACY_CONSENT_STORAGE_KEY]: CONSENT_CHOICES.accepted,
    });
    expect(getStoredConsentChoice(storage, NOW)).toBe(CONSENT_CHOICES.declined);
  });
});

describe("shouldLoadAnalytics", () => {
  it("is false when Do Not Track is set, even with a stored acceptance", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.accepted),
    });
    const navigatorFixture = createNavigatorFixture({ doNotTrack: "1" });
    expect(shouldLoadAnalytics(navigatorFixture, storage)).toBe(false);
  });

  it("is false when Global Privacy Control is set, even with a stored acceptance", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.accepted),
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
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.declined),
    });
    expect(shouldLoadAnalytics(createNavigatorFixture(), storage)).toBe(false);
  });

  it("is true only when neither signal is set and consent was accepted", () => {
    const storage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.accepted),
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
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.accepted),
    });
    const declinedStorage = createFakeStorage({
      [CONSENT_STORAGE_KEY]: unexpiredRecord(CONSENT_CHOICES.declined),
    });
    expect(
      shouldPromptForConsent(createNavigatorFixture(), acceptedStorage),
    ).toBe(false);
    expect(
      shouldPromptForConsent(createNavigatorFixture(), declinedStorage),
    ).toBe(false);
  });
});

describe("setStoredConsentChoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when the underlying storage.setItem throws (e.g. quota exceeded)", () => {
    const throwingStorage: ConsentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    expect(() =>
      setStoredConsentChoice(throwingStorage, CONSENT_CHOICES.accepted),
    ).not.toThrow();
  });

  it("warns (rather than failing silently) when persistence fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingStorage: ConsentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    setStoredConsentChoice(throwingStorage, CONSENT_CHOICES.accepted);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("getConsentStorage", () => {
  const PROBE_KEY = "np-analytics-consent-probe-test";

  afterEach(() => {
    localStorage.removeItem(PROBE_KEY);
  });

  it("returns the real localStorage when it's usable", () => {
    const storage = getConsentStorage();
    // Identity, not just behavior: a fallback that happens to read/write
    // correctly would still pass a purely behavioral assertion here, so also
    // pin that the happy path really is the live global, not a look-alike.
    expect(storage).toBe(window.localStorage);
    storage.setItem(PROBE_KEY, "1");
    expect(localStorage.getItem(PROBE_KEY)).toBe("1");
  });

  it("falls back to an in-memory no-op storage when localStorage throws (e.g. Safari 'Block all cookies')", () => {
    // Shadowing individual methods on the real localStorage instance
    // (`window.localStorage.setItem = ...`) doesn't reliably take in
    // happy-dom's Storage implementation, so replace the whole global
    // binding instead — `vi.stubGlobal` is what this codebase already uses
    // for exactly this kind of global replacement (see
    // csp/notifyPruneFailure.test.ts's `vi.stubGlobal("fetch", ...)`).
    const blockedStorage: Storage = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      clear: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    vi.stubGlobal("localStorage", blockedStorage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = getConsentStorage();
      expect(warn).toHaveBeenCalledTimes(1);
      // Both real localStorage and a working fallback would report null for
      // an untouched key, so that alone can't prove the fallback fired.
      // Pin identity (not the blocked Storage instance) and non-persistence
      // (a write that would actually reach the blocked storage and throw)
      // instead.
      expect(storage).not.toBe(blockedStorage);
      expect(() =>
        storage.setItem(CONSENT_STORAGE_KEY, CONSENT_CHOICES.accepted),
      ).not.toThrow();
      expect(storage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });
});
