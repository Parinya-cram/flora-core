import { describe, expect, it } from "vitest";
import { parseHexColor, smartContrastColor, type Rgb } from "../../src/utils/smartContrast";

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const DARK: Rgb = { r: 28, g: 28, b: 28 };
// Series colours configured for the dark chart (clinical_parameter_master.chart_color).
const SERIES = { art: "#EF9696", cvp: "#C6A7F2", hr: "#F5F7FA", nibp: "#8ED99A", pr: "#78D9C6", spo2: "#8CBFF2", temp: "#F2BF75" };

function luminance(color: Rgb) {
  const channel = (value: number) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
function contrast(a: Rgb, b: Rgb) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hue({ r, g, b }: Rgb) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("smartContrastColor", () => {
  it("leaves colours that already stand out on the chart", () => {
    for (const color of Object.values(SERIES)) expect(smartContrastColor(color, DARK, true)).toBe(color);
  });

  it("is off when disabled", () => {
    expect(smartContrastColor("#F5F7FA", WHITE, false)).toBe("#F5F7FA");
  });

  it("darkens pastel series on a white chart to 3:1 and keeps their hue", () => {
    for (const [key, color] of Object.entries(SERIES)) {
      if (key === "hr") continue;
      const adjusted = parseHexColor(smartContrastColor(color, WHITE, true))!;
      expect(contrast(adjusted, WHITE)).toBeGreaterThanOrEqual(3);
      const shift = Math.abs(hue(adjusted) - hue(parseHexColor(color)!));
      expect(Math.min(shift, 360 - shift)).toBeLessThan(12);
    }
  });

  it("inverts a near-white series (HR) to near-black on a white chart", () => {
    const adjusted = parseHexColor(smartContrastColor(SERIES.hr, WHITE, true))!;
    expect(contrast(adjusted, WHITE)).toBeGreaterThanOrEqual(7);
  });

  it("keeps series distinguishable on a white chart", () => {
    const adjusted = Object.values(SERIES).map(color => smartContrastColor(color, WHITE, true));
    expect(new Set(adjusted).size).toBe(adjusted.length);
    const greyish = adjusted.map(color => parseHexColor(color)!).filter(({ r, g, b }) => Math.max(r, g, b) - Math.min(r, g, b) < 40);
    expect(greyish.length).toBeLessThanOrEqual(1); // only HR may be neutral
  });

  it("lightens dark series on a dark chart", () => {
    const adjusted = parseHexColor(smartContrastColor("#1d4f91", DARK, true))!;
    expect(contrast(adjusted, DARK)).toBeGreaterThanOrEqual(3);
  });
});
