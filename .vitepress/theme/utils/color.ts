// Accent glows (heading text-shadow, aurora blobs, CTA shadows) are all the
// project's accent color at a different alpha. Deriving them from the one hex
// keeps a single source of truth instead of hand-written rgba() strings.
const SIX_DIGIT_HEX = /^#?([0-9a-f]{6})$/i;

export function hexToRgba(hex: string, alpha: number): string {
  const match = SIX_DIGIT_HEX.exec(hex.trim());
  // Fail loud: a malformed hex or alpha would otherwise yield "rgba(NaN, …)", a
  // declaration the browser silently drops, leaving an invisible glow.
  if (!match) {
    throw new Error(`hexToRgba: expected a six-digit hex, got "${hex}"`);
  }
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error(
      `hexToRgba: expected an alpha between 0 and 1, got "${alpha}"`,
    );
  }
  const [, normalized] = match;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
