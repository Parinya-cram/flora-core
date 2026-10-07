/**
 * Resolved style tokens -> CSS for the renderers. Units: pt for type, mm for lengths, so screen and A4
 * print use one set of numbers.
 */
import type { CSSProperties } from "react";
import { FontRegistry } from "../core/fonts";
import { componentTokens, StyleRegistry, type ResolvedStyle } from "../core/styles";
import type { FontEntry, FormDefinition, StyleEntry } from "../core/types";
import { styleRef } from "../core/validate";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../registry/defaults";

export type Registries = { styles: StyleRegistry; fonts: FontRegistry };

const cache = new WeakMap<object, Registries>();

/** Registries from server rows, or the bundled defaults (offline preview, standalone). */
export function registries(styles?: StyleEntry[], fonts?: FontEntry[]): Registries {
  const key = styles ?? DEFAULT_STYLES;
  const cached = cache.get(key);
  if (cached && !fonts) return cached;
  const built = { styles: new StyleRegistry(key), fonts: new FontRegistry(fonts ?? DEFAULT_FONTS) };
  if (!fonts) cache.set(key, built);
  return built;
}

/** Form-level style: registry style + override, then the definition's font_id. */
export function formStyle(definition: FormDefinition, regs: Registries): ResolvedStyle {
  const style = regs.styles.apply(regs.styles.resolve(styleRef(definition)), definition.style?.override ? { override: definition.style.override } : undefined);
  return definition.font_id ? { ...style, tokens: { ...style.tokens, fontId: definition.font_id } } : style;
}

const num = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
const text = (value: unknown, fallback: string) => (typeof value === "string" && value !== "transparent" ? value : fallback);

/** Typography of a component (or the base tokens). */
export function typeCss(style: ResolvedStyle, regs: Registries, component?: "label" | "section" | "header" | "footer" | "input"): CSSProperties {
  const tokens = componentTokens(style, component);
  const css: CSSProperties = {
    fontFamily: regs.fonts.stack(typeof tokens.fontId === "string" ? tokens.fontId : undefined),
    fontSize: `${num(tokens.fontSize, 11)}pt`,
    fontWeight: num(tokens.fontWeight, 400),
    lineHeight: num(tokens.lineHeight, 1.4),
    color: text(tokens.color, "#1f2937"),
    textAlign: (tokens.align as CSSProperties["textAlign"]) ?? "left",
  };
  if (tokens.uppercase === true) css.textTransform = "uppercase";
  return css;
}

export function rootCss(style: ResolvedStyle, regs: Registries): CSSProperties {
  return { ...typeCss(style, regs), background: text(style.tokens.background, "#ffffff") };
}

export function gridCss(columns: number, style: ResolvedStyle): CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: `${num(style.tokens.gap, 3)}mm` };
}

export function sectionCss(style: ResolvedStyle): CSSProperties {
  const rule = style.tokens.rule;
  const padding = `${num(style.tokens.padding, 1.5) * 2}mm`;
  const background = text(style.tokens.background, "transparent");
  if (rule === "card") return { border: `0.3mm solid ${text(style.tokens.borderColor, "#cbd5e1")}`, borderRadius: `${num(style.tokens.radius, 1.5) * 2}mm`, padding, background };
  if (rule === "solid") return { borderTop: `0.4mm solid ${text(style.tokens.borderColor, "#cbd5e1")}`, paddingTop: padding, background };
  return { background };
}

export function inputCss(style: ResolvedStyle, regs: Registries): CSSProperties {
  const tokens = componentTokens(style, "input");
  const color = text(tokens.borderColor, "#cbd5e1");
  const border = tokens.border;
  const css: CSSProperties = {
    ...typeCss(style, regs, "input"),
    width: "100%",
    minHeight: `${num(tokens.inputHeight, 8)}mm`,
    padding: `0 ${num(tokens.padding, 1.5)}mm`,
    borderRadius: border === "underline" ? 0 : `${num(tokens.radius, 1.5)}mm`,
    background: "#ffffff",
    boxSizing: "border-box",
  };
  if (border === "none") css.border = "none";
  else if (border === "underline") Object.assign(css, { border: "none", borderBottom: `0.3mm solid ${color}` });
  else css.border = `0.3mm ${border === "dashed" ? "dashed" : "solid"} ${color}`;
  return css;
}
