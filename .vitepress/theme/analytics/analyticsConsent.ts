// Site wiring for @neon-pixels/consent. The package owns the stored choice,
// the privacy-signal check, and the cookie clean-up; this file only supplies
// this site's settings and the one protection the package leaves to callers.
import {
  consentStorageKey,
  createConsent,
  type Consent,
  type ConsentStorage,
} from "@neon-pixels/consent";
import { GA_MEASUREMENT_ID } from "./loadGoogleAnalytics";

// Keeps the stored key `neonpixels:analytics-consent`.
export const CONSENT_APP = "neonpixels";

// The bare-string key used before the fleet-wide `{ choice, expiresAt }`
// shape. The package still reads it so returning visitors keep their choice.
export const LEGACY_CONSENT_STORAGE_KEY = "np-analytics-consent";

// The visible label on ConsentBanner.vue's re-open control. Exported so
// PrivacyPolicy.vue can reference the exact same string when it tells a
// visitor what to look for.
export const MANAGE_CHOICE_LABEL = "Analytics choice";

// Merely reading `window.localStorage` (not just calling a method on it)
// throws a SecurityError in Safari with "Block all cookies" and some
// locked-down webviews. The package swallows errors from the storage methods
// but cannot guard the property read, so probe it here and fall back to an
// in-memory no-op that always reads back null: analytics stays off and the
// banner re-prompts every visit instead of crashing.
export function getConsentStorage(): ConsentStorage {
  try {
    const probeKey = "__np_analytics_consent_probe__";
    window.localStorage.setItem(probeKey, probeKey);
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch (error) {
    console.warn(
      "Analytics consent storage is unavailable; falling back to an in-memory choice for this page load.",
      error,
    );
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

// Client-only: reads `navigator` and `window`, so call it from onMounted.
export function createSiteConsent(storage: ConsentStorage): Consent {
  return createConsent({
    app: CONSENT_APP,
    services: { analytics: { measurementId: GA_MEASUREMENT_ID } },
    storage,
    navigator,
    window,
    legacyKey: LEGACY_CONSENT_STORAGE_KEY,
  });
}

// True when an earlier visit left any choice (current or legacy key) behind.
export function hasStoredChoice(storage: ConsentStorage): boolean {
  return [consentStorageKey(CONSENT_APP), LEGACY_CONSENT_STORAGE_KEY].some(
    (key) => storage.getItem(key) !== null,
  );
}
