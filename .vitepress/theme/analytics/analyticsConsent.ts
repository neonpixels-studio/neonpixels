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
// in-memory store for this page load: the choice does not persist, so the
// banner re-prompts on the next visit instead of crashing.
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
    return createInMemoryStorage();
  }
}

function createInMemoryStorage(): ConsentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
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

const GRANTED_VALUES = new Set(["granted", "accepted"]);

function parseChoice(rawValue: string): unknown {
  if (GRANTED_VALUES.has(rawValue)) {
    return rawValue;
  }
  try {
    return JSON.parse(rawValue)?.choice;
  } catch {
    return undefined;
  }
}

function isGrantValue(rawValue: string | null): boolean {
  if (rawValue === null) {
    return false;
  }
  const choice = parseChoice(rawValue);
  return typeof choice === "string" && GRANTED_VALUES.has(choice);
}

// True when an earlier visit stored a grant, expired or not. The current key
// is authoritative; the legacy key counts only while the current one is
// absent, as in the package. Read raw because the package reports no choice
// while a privacy signal is present, yet must still be told to deny() so it
// clears the cookies that grant left behind.
export function hasStoredGrant(storage: ConsentStorage): boolean {
  const current = storage.getItem(consentStorageKey(CONSENT_APP));
  if (current !== null) {
    return isGrantValue(current);
  }
  return isGrantValue(storage.getItem(LEGACY_CONSENT_STORAGE_KEY));
}
