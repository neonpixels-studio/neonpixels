// Consent + tracking-signal logic for GA4. Kept isolated from both the GA4
// script loader (loadGoogleAnalytics.ts) and the UI (ConsentBanner.vue) so
// each half is independently testable.

// `"1"` is the only value the (now-abandoned) DNT spec ever defined for
// `navigator.doNotTrack`, and the only one current evergreen browsers report.
// `"yes"` is kept alongside it for older/embedded WebViews reported to use
// that spelling — a set rather than a single literal costs nothing and can
// only widen coverage, never produce a false positive from a real signal.
const DO_NOT_TRACK_ENABLED_VALUES = new Set(["1", "yes"]);

export const CONSENT_STORAGE_KEY = "np-analytics-consent";

export const CONSENT_CHOICES = {
  accepted: "accepted",
  declined: "declined",
} as const;

export type ConsentChoice =
  (typeof CONSENT_CHOICES)[keyof typeof CONSENT_CHOICES];

// The subset of `Navigator` this module reads, so tests can pass a plain
// object fixture instead of stubbing the real global. Declared by hand
// (rather than `Pick<Navigator, ...>`) because Global Privacy Control
// (https://globalprivacycontrol.org) isn't yet part of TypeScript's DOM
// lib — `navigator.globalPrivacyControl` is read via a runtime-only optional
// property, same as browsers that don't support it leave it `undefined`.
export interface TrackingSignalSource {
  doNotTrack: Navigator["doNotTrack"];
  globalPrivacyControl?: boolean;
}

// The subset of `Storage` this module reads/writes, so tests can pass an
// in-memory fake instead of touching real localStorage/happy-dom.
export type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

// Merely reading `window.localStorage` (not just calling a method on it)
// throws a SecurityError in Safari with "Block all cookies", some locked-down
// webviews, and old Safari private-mode quota edge cases. A privacy-hardened
// visitor is exactly who this feature is for, so probe it and fall back to an
// in-memory no-op rather than letting ConsentBanner.vue's onMounted throw.
// The no-op always reads back null, so downstream checks fail closed:
// analytics stays off and the banner re-prompts every visit instead of
// crashing.
export function getConsentStorage(): ConsentStorage {
  try {
    const probeKey = "__np_analytics_consent_probe__";
    window.localStorage.setItem(probeKey, probeKey);
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

// True when the visitor's browser has asked, via either standard signal, not
// to be tracked. This is an opt-out signal, not a consent record — it's
// checked before consulting the stored choice, and (unlike a declined choice)
// it also suppresses the consent banner itself, since re-prompting someone
// who already told their browser "don't track me" would just be noise.
export function trackingSignalPresent(navigatorLike: TrackingSignalSource) {
  return (
    DO_NOT_TRACK_ENABLED_VALUES.has(navigatorLike.doNotTrack ?? "") ||
    navigatorLike.globalPrivacyControl === true
  );
}

// Reads the visitor's prior banner choice, if any. Returns null both when no
// choice has been recorded yet and when a corrupted/foreign value is present
// — either way, "no valid stored choice" and "never answered" get the same
// treatment from every caller.
export function getStoredConsentChoice(
  storage: ConsentStorage,
): ConsentChoice | null {
  const storedValue = storage.getItem(CONSENT_STORAGE_KEY);
  if (storedValue === CONSENT_CHOICES.accepted) {
    return CONSENT_CHOICES.accepted;
  }
  if (storedValue === CONSENT_CHOICES.declined) {
    return CONSENT_CHOICES.declined;
  }
  return null;
}

export function setStoredConsentChoice(
  storage: ConsentStorage,
  choice: ConsentChoice,
) {
  try {
    storage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // Best-effort persistence: if this throws (e.g. a Safari private-mode
    // quota), the choice just doesn't survive a reload and the banner
    // reappears next visit — safe degradation, not a thrown error mid-click.
  }
}

// GA4 loads only when the visitor hasn't signaled DNT/GPC AND has actively
// accepted the banner. Declining, or not having answered yet, both withhold
// analytics — the safe default is "off".
export function shouldLoadAnalytics(
  navigatorLike: TrackingSignalSource,
  storage: ConsentStorage,
) {
  if (trackingSignalPresent(navigatorLike)) {
    return false;
  }
  return getStoredConsentChoice(storage) === CONSENT_CHOICES.accepted;
}

// The banner only makes sense to show when there's an actual decision left
// to make: no DNT/GPC signal (that already answered the question) and no
// stored choice yet (the visitor hasn't answered it themselves).
export function shouldPromptForConsent(
  navigatorLike: TrackingSignalSource,
  storage: ConsentStorage,
) {
  if (trackingSignalPresent(navigatorLike)) {
    return false;
  }
  return getStoredConsentChoice(storage) === null;
}
