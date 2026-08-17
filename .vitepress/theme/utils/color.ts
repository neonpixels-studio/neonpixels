// Accent glows (heading text-shadow, aurora blobs, CTA shadows) are all the
// project's accent color at a different alpha. Deriving them from the one hex
// keeps a single source of truth instead of hand-written rgba() strings.
const SIX_DIGIT_HEX = /^#?([0-9a-f]{6})$/i;

// WCAG 2.x relative-luminance constants (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance).
const SRGB_LINEAR_THRESHOLD = 0.03928;
const SRGB_LOW_DIVISOR = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const LUMINANCE_RED_COEFFICIENT = 0.2126;
const LUMINANCE_GREEN_COEFFICIENT = 0.7152;
const LUMINANCE_BLUE_COEFFICIENT = 0.0722;
// The +0.05 flare in the contrast-ratio formula that keeps pure black finite.
const CONTRAST_FLARE = 0.05;

type RgbChannels = { red: number; green: number; blue: number };

// Fail loud: a malformed hex would otherwise yield "rgba(NaN, …)" or a NaN
// luminance, both silently wrong, so reject rather than emit garbage. `caller`
// keeps the stack-less error naming the exported function that was misused.
function hexToChannels(hex: string, caller: string): RgbChannels {
  const match = SIX_DIGIT_HEX.exec(hex.trim());
  if (!match) {
    throw new Error(`${caller}: expected a six-digit hex, got "${hex}"`);
  }
  const [, normalized] = match;
  return {
    red: parseInt(normalized.slice(0, 2), 16),
    green: parseInt(normalized.slice(2, 4), 16),
    blue: parseInt(normalized.slice(4, 6), 16),
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const { red, green, blue } = hexToChannels(hex, "hexToRgba");
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error(
      `hexToRgba: expected an alpha between 0 and 1, got "${alpha}"`,
    );
  }
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// Linearize one 0–255 channel to its sRGB light contribution.
function channelToLinear(channel: number): number {
  const proportion = channel / 255;
  if (proportion <= SRGB_LINEAR_THRESHOLD) {
    return proportion / SRGB_LOW_DIVISOR;
  }
  return Math.pow((proportion + SRGB_OFFSET) / SRGB_SCALE, SRGB_GAMMA);
}

export function relativeLuminance(hex: string): number {
  const { red, green, blue } = hexToChannels(hex, "relativeLuminance");
  return (
    LUMINANCE_RED_COEFFICIENT * channelToLinear(red) +
    LUMINANCE_GREEN_COEFFICIENT * channelToLinear(green) +
    LUMINANCE_BLUE_COEFFICIENT * channelToLinear(blue)
  );
}

export function contrastRatio(
  foregroundHex: string,
  backgroundHex: string,
): number {
  const foregroundLuminance = relativeLuminance(foregroundHex);
  const backgroundLuminance = relativeLuminance(backgroundHex);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + CONTRAST_FLARE) / (darker + CONTRAST_FLARE);
}
