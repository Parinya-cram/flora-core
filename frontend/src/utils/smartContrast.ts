export type Rgb = { r: number; g: number; b: number };

export function parseHexColor(color: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

function rgbToHex(color: Rgb) {
  return `#${[color.r, color.g, color.b].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(color: Rgb) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: Rgb, second: Rgb) {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

type Hsl = { h: number; s: number; l: number };

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

/** Lines and markers need 3:1 against the chart (WCAG non-text contrast). */
const SERIES_CONTRAST = 3;
/** Near-white / grey series (e.g. HR white on a dark chart) invert to near-black on a light one. */
const NEUTRAL_CONTRAST = 7;

/**
 * Smart invert: a series colour that blends into the chart background gets only its lightness changed
 * (darker on a light chart, lighter on a dark one). Hue is kept and colourful series stay saturated, so
 * series stay distinguishable instead of all fading to grey/black.
 */
export function smartContrastColor(color: string, background: Rgb, enabled: boolean) {
  if (!enabled) return color;
  const source = parseHexColor(color);
  if (!source) return color;
  const hsl = rgbToHsl(source);
  const neutral = hsl.s < 0.35 || hsl.l > 0.92;
  const minimum = neutral ? NEUTRAL_CONTRAST : SERIES_CONTRAST;
  if (contrastRatio(source, background) >= minimum) return color;
  const darken = relativeLuminance(background) > 0.18;
  const saturation = neutral ? Math.min(hsl.s, 0.2) : Math.max(hsl.s, 0.6);
  // Binary search for the lightness closest to the original that still reaches the contrast.
  let low = darken ? 0 : hsl.l;
  let high = darken ? hsl.l : 1;
  let best: Rgb | null = null;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    const candidate = hslToRgb({ h: hsl.h, s: saturation, l: middle });
    if (contrastRatio(candidate, background) >= minimum) {
      best = candidate;
      if (darken) low = middle; else high = middle;
    } else if (darken) high = middle; else low = middle;
  }
  return rgbToHex(best ?? (darken ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }));
}
