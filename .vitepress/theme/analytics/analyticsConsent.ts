// Consent + tracking-signal logic for GA4. Kept isolated from both the GA4
// script loader (loadGoogleAnalytics.ts) and the UI (ConsentBanner.vue) so
// each half is independently testable.

// `"1"` is the only value the (now-abandoned) DNT spec ever defined for
// `navigator.doNotTrack`, and the only one current evergreen browsers report.
// `"yes"` is kept alongside it for older/embedded WebViews reported to use
// that spelling — a set rather than a single literal costs nothing and can
// only widen coverage, never produce a false positive from a real signal.
const DO_NOT_TRACK_ENABLED_VALUES = new Set(["1", "yes"]);

export const CONSENT_STORAGE_KEY = "neonpixels:analytics-consent";

// The bare-string key used before the fleet-wide `{ choice, expiresAt }`
// shape. Read once for migration, then removed.
export const LEGACY_CONSENT_STORAGE_KEY = "np-analytics-consent";

export const CONSENT_LIFETIME_DAYS = 180;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const CONSENT_LIFETIME_MS = CONSENT_LIFETIME_DAYS * MILLISECONDS_PER_DAY;

// The visible label on ConsentBanner.vue's re-open control. Exported so
// PrivacyPolicy.vue can reference the exact same string when it tells a
// visitor what to look for, rather than a hand-typed copy the two files
// could silently drift apart from if the button were ever relabeled.
export const MANAGE_CHOICE_LABEL = "Analytics choice";

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

export interface StoredConsent {
  choice: ConsentChoice;
  // Epoch milliseconds after which the choice no longer counts.
  expiresAt: number;
}

// The subset of `Storage` this module reads/writes, so tests can pass an
// in-memory fake instead of touching real localStorage/happy-dom.
export type ConsentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

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
  } catch (error) {
    // Matches this codebase's degraded-path convention (see AppLayout.vue's
    // missing-landmark guard): warn rather than fail silently, so "the banner
    // keeps re-prompting" is diagnosable instead of a dead end.
    console.warn(
      "Analytics consent storage is unavailable; falling back to an in-memory choice for this page load.",
      error,
    );
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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

function isConsentChoice(value: unknown): value is ConsentChoice {
  return (
    value === CONSENT_CHOICES.accepted || value === CONSENT_CHOICES.declined
  );
}

// Returns null for anything that is not a well-formed, unexpired record, so
// a malformed or expired value is treated exactly like "never answered".
function parseStoredConsent(
  rawValue: string | null,
  now: number,
): ConsentChoice | null {
  if (rawValue === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawValue);
    const { choice, expiresAt } = (parsed ?? {}) as Partial<StoredConsent>;
    if (!isConsentChoice(choice) || typeof expiresAt !== "number") {
      return null;
    }
    return expiresAt > now ? choice : null;
  } catch {
    return null;
  }
}

// Moves a value under the previous key to the current key, keeping the choice
// and starting the 180 days from now, then removes the old key. A legacy value
// that is not a recognized choice is dropped.
function migrateLegacyConsentChoice(storage: ConsentStorage, now: number) {
  const legacyValue = storage.getItem(LEGACY_CONSENT_STORAGE_KEY);
  if (legacyValue === null) {
    return;
  }
  if (isConsentChoice(legacyValue)) {
    setStoredConsentChoice(storage, legacyValue, now);
  }
  storage.removeItem(LEGACY_CONSENT_STORAGE_KEY);
}

// Reads the visitor's prior banner choice, if any. Returns null when no
// choice has been recorded, when it has expired, and when a corrupted/foreign
// value is present: every caller treats those the same as "never answered".
export function getStoredConsentChoice(
  storage: ConsentStorage,
  now: number = Date.now(),
): ConsentChoice | null {
  if (storage.getItem(CONSENT_STORAGE_KEY) === null) {
    migrateLegacyConsentChoice(storage, now);
  }
  return parseStoredConsent(storage.getItem(CONSENT_STORAGE_KEY), now);
}

export function setStoredConsentChoice(
  storage: ConsentStorage,
  choice: ConsentChoice,
  now: number = Date.now(),
) {
  const record: StoredConsent = {
    choice,
    expiresAt: now + CONSENT_LIFETIME_MS,
  };
  try {
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    // Best-effort persistence: if this throws (e.g. a Safari private-mode
    // quota), the choice just doesn't survive a reload and the banner
    // reappears next visit — safe degradation, not a thrown error mid-click,
    // but still warned so it's diagnosable rather than a dead end.
    console.warn(
      "Analytics consent choice could not be persisted; it will not survive a reload.",
      error,
    );
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
