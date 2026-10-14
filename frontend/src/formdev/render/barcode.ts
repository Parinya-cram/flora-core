/**
 * Linear barcodes for printed forms (field type barcode): the bars of a value in module units, drawn the same way on
 * screen (SVG) and in the PDF. Interleaved 2 of 5 is Flora Leaf's HN barcode (components/common/HnBarcode.tsx,
 * electron/reportPdf.cjs: digits only, an odd count gets a leading 0, wide = 2.5 narrow); Code 128 (set B, or set C
 * for an even run of digits) and Code 39 also take letters, e.g. AN "67-00123".
 */
export type Symbology = "i2of5" | "code128" | "code39";
/** bars: the dark bars, x and w in modules from the left edge (quiet zones included in width). */
export type Barcode = { bars: Array<{ x: number; w: number }>; width: number; text: string };

const QUIET = 10;
const WIDE = 2.5;

/** Bars of alternating bar / space widths, starting with a bar, after the left quiet zone. */
function fromWidths(widths: number[], text: string): Barcode {
  const bars: Barcode["bars"] = [];
  let x = QUIET;
  widths.forEach((w, index) => {
    if (index % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return { bars, width: x + QUIET, text };
}

const I2OF5: Record<string, string> = {
  "0": "nnwwn", "1": "wnnnw", "2": "nwnnw", "3": "wwnnn", "4": "nnwnw", "5": "wnwnn", "6": "nwwnn", "7": "nnnww", "8": "wnnwn", "9": "nwnwn",
};

function interleaved2of5(raw: string): Barcode | null {
  let digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length % 2 === 1) digits = `0${digits}`;
  const widths = [1, 1, 1, 1];
  for (let index = 0; index < digits.length; index += 2) {
    const bars = I2OF5[digits[index]];
    const spaces = I2OF5[digits[index + 1]];
    for (let bit = 0; bit < 5; bit += 1) widths.push(bars[bit] === "w" ? WIDE : 1, spaces[bit] === "w" ? WIDE : 1);
  }
  widths.push(WIDE, 1, 1);
  return fromWidths(widths, digits);
}

/** Code 39: bar space bar space ... (9 elements, 3 wide), a narrow gap between characters, * as start / stop. */
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn", A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn",
  G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn", K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww",
  O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn", U: "wwnnnnnnw", V: "nwwnnnnnw",
  W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn", Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "$": "nwnwnwnnn",
  "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn",
};

function code39(raw: string): Barcode | null {
  const text = raw.trim().toUpperCase();
  if (!text || [...text].some(char => char === "*" || !CODE39[char])) return null;
  const widths: number[] = [];
  [...`*${text}*`].forEach((char, index) => {
    if (index > 0) widths.push(1); // the gap between characters (a space)
    for (const element of CODE39[char]) widths.push(element === "w" ? WIDE : 1);
  });
  return fromWidths(widths, text);
}

/** Code 128 patterns 0-105 (bar, space, ... six widths of 11 modules) and the stop (seven widths, 13 modules). */
export const CODE128 = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232",
];
const STOP = "2331112";
const START_B = 104;
const START_C = 105;

/** Code values: set C (pairs of digits) for an all-digit value of even length, otherwise set B (printable ASCII). */
export function code128Values(raw: string): number[] | null {
  const text = raw.trim();
  if (!text) return null;
  const values = /^\d+$/.test(text) && text.length % 2 === 0 && text.length >= 4
    ? [START_C, ...(text.match(/\d\d/g) ?? []).map(Number)]
    : [...text].every(char => char >= " " && char <= "~") ? [START_B, ...[...text].map(char => char.charCodeAt(0) - 32)] : null;
  if (!values) return null;
  const check = values.reduce((sum, value, index) => sum + value * Math.max(index, 1), 0) % 103;
  return [...values, check];
}

function code128(raw: string): Barcode | null {
  const values = code128Values(raw);
  if (!values) return null;
  const widths = [...values.map(value => CODE128[value]).join(""), ...STOP].map(Number);
  return fromWidths(widths, raw.trim());
}

/** The barcode of a value, or null when the value is empty or cannot be encoded in this symbology. */
export function encodeBarcode(symbology: Symbology | undefined, value: unknown): Barcode | null {
  const text = value === null || value === undefined ? "" : String(value);
  if (symbology === "code128") return code128(text);
  if (symbology === "code39") return code39(text);
  // Interleaved 2 of 5 holds digits only. Separators (space - / .) are dropped as Flora Leaf does, but a value with
  // letters (HN "D-HL7-001") would shrink to other digits ("7001") and scan as a different patient: it is printed
  // in Code 128 instead, with the whole value.
  if (/[^\d\s\-/.]/.test(text.trim())) return code128(text);
  return interleaved2of5(text);
}
