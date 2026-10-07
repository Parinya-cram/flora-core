/**
 * Font registry (Phase 1.7). Forms and styles name fonts by font_id only. Each entry keeps four
 * separate things: the registry id, metadata (family, scripts, licence), assets (where glyphs come
 * from: a bundled package, the workstation, an uninstalled open-licence alternative) and the fallback
 * chain. FormDev ships no font files; the 13+1 Thai official fonts resolve to the copy installed on the
 * workstation and otherwise fall back to the bundled Noto Sans Thai.
 */
import type { FontEntry, JsonValue } from "./types";

export type FontAsset = { kind: "bundled" | "system" | "web_alternative" | "file"; family?: string; package?: string; installed?: boolean; license?: string; note?: string };
export type FontMetadata = { family: string; display_name?: string; category?: string; official?: boolean; scripts?: string[]; weights?: number[]; license?: string } & Record<string, JsonValue | undefined>;
export type FontInfo = { font_id: string; metadata: FontMetadata; assets: FontAsset[]; fallback: string[] };

export const DEFAULT_FONT_ID = "noto-sans-thai";
const DEFAULT_STACK = ["Noto Sans Thai Variable", "Noto Sans Thai", "Tahoma", "sans-serif"];
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

/** A stored row (metadata + assets + fallback in one object, or the older {family, fallback, source, package}). */
export function normalizeFont(row: FontEntry): FontInfo {
  const stored = row.metadata as Record<string, unknown>;
  const { assets, fallback, source, package: pkg, ...metadata } = stored;
  let assetList = Array.isArray(assets) ? (assets as FontAsset[]) : [];
  if (!assetList.length && source === "bundled" && typeof pkg === "string") assetList = [{ kind: "bundled", package: pkg, installed: true }];
  const chain = Array.isArray(fallback) ? fallback.filter((item): item is string => typeof item === "string") : [];
  const family = typeof metadata.family === "string" ? metadata.family : row.font_id;
  return { font_id: row.font_id, metadata: { ...(metadata as FontMetadata), family }, assets: assetList, fallback: chain.length ? chain : [family, ...DEFAULT_STACK] };
}

const quote = (family: string) => (GENERIC.has(family) ? family : `"${family.replace(/["\\]/g, "")}"`);

export class FontRegistry {
  private readonly fonts = new Map<string, FontInfo>();

  constructor(rows: FontEntry[]) {
    for (const row of rows) this.fonts.set(row.font_id, normalizeFont(row));
  }

  has(fontId: string): boolean {
    return this.fonts.has(fontId);
  }

  get(fontId: string): FontInfo | undefined {
    return this.fonts.get(fontId);
  }

  official(): FontInfo[] {
    return [...this.fonts.values()].filter(font => font.metadata.official === true);
  }

  /** CSS font-family for a font id: its family, then its fallback chain; unknown ids use the default stack. */
  stack(fontId: string | undefined): string {
    const font = fontId ? this.fonts.get(fontId) : undefined;
    const families = font ? [font.metadata.family, ...font.fallback] : [...(this.fonts.get(DEFAULT_FONT_ID)?.fallback ?? DEFAULT_STACK)];
    if (!families.some(family => GENERIC.has(family))) families.push("sans-serif");
    return [...new Set(families)].map(quote).join(", ");
  }
}
