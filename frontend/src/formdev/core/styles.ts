/**
 * Style registry and inheritance (Phase 1.8, 1.9). A style row is {name, category, inherit?, paper?, tokens,
 * components?}; tokens are the ones in fieldTypes.STYLE_TOKENS. The cascade is
 *   base style -> form style -> section style -> field style -> instance override,
 * so a form changes one property with an override instead of copying a whole style.
 * Twin of the validation in services/flora-api/app/formdev/styles.py.
 */
import { STYLE_COMPONENTS, type StyleComponent } from "./fieldTypes";
import type { JsonValue, StyleEntry, StyleRef } from "./types";

export type TokenMap = Record<string, JsonValue>;
export type StyleDefinition = {
  name: string;
  category: "base" | "form" | "section" | "field";
  inherit?: string;
  paper?: string;
  tokens: TokenMap;
  components?: Partial<Record<StyleComponent, TokenMap>>;
};
export type ResolvedStyle = { tokens: TokenMap; components: Record<StyleComponent, TokenMap> };

const MAX_INHERIT_DEPTH = 8;
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isComponent = (name: string): name is StyleComponent => (STYLE_COMPONENTS as readonly string[]).includes(name);

export const emptyStyle = (): ResolvedStyle => ({ tokens: {}, components: { label: {}, input: {}, section: {}, header: {}, footer: {} } });

/** Map a pre-Phase-1 style row onto tokens. Twin of styles.normalize_style. */
export function normalizeStyle(definition: Obj): StyleDefinition {
  if ("tokens" in definition) return definition as unknown as StyleDefinition;
  const tokens: TokenMap = {};
  const components: Partial<Record<StyleComponent, TokenMap>> = {};
  if (typeof definition.font_id === "string") tokens.fontId = definition.font_id;
  if (typeof definition.base_size_pt === "number") tokens.fontSize = definition.base_size_pt;
  if (Number.isInteger(definition.columns)) tokens.columns = definition.columns as number;
  const margin = isObject(definition.margin_mm) ? definition.margin_mm : {};
  for (const side of ["top", "right", "bottom", "left"]) {
    if (typeof margin[side] === "number") tokens[`pageMargin${side[0].toUpperCase()}${side.slice(1)}`] = margin[side] as number;
  }
  const label = isObject(definition.label) ? definition.label : {};
  if (Object.keys(label).length) {
    components.label = Object.fromEntries([["fontWeight", label.weight], ["fontSize", label.size_pt]].filter(([, value]) => value !== undefined && value !== null)) as TokenMap;
  }
  const section = isObject(definition.section) ? definition.section : {};
  if (["none", "solid", "card"].includes(section.rule as string)) tokens.rule = section.rule as string;
  if (section.title_size_pt !== undefined && section.title_size_pt !== null) components.section = { fontSize: section.title_size_pt as number };
  const out: StyleDefinition = { name: (definition.title as string) || "Style", category: "form", tokens };
  if (definition.paper) out.paper = definition.paper as string;
  if (Object.keys(components).length) out.components = components;
  return out;
}

/** Later layers win; components merge per component. */
export function mergeStyle(base: ResolvedStyle, layer: { tokens?: TokenMap; components?: Partial<Record<StyleComponent, TokenMap>> }): ResolvedStyle {
  const out: ResolvedStyle = { tokens: { ...base.tokens, ...(layer.tokens ?? {}) }, components: { ...base.components } };
  for (const name of STYLE_COMPONENTS) out.components[name] = { ...base.components[name], ...(layer.components?.[name] ?? {}) };
  return out;
}

/** Split an instance override ({fontSize: 14, label: {...}}) into tokens and components. */
export function overrideLayer(override: unknown): { tokens: TokenMap; components: Partial<Record<StyleComponent, TokenMap>> } {
  const tokens: TokenMap = {};
  const components: Partial<Record<StyleComponent, TokenMap>> = {};
  if (!isObject(override)) return { tokens, components };
  for (const [name, value] of Object.entries(override)) {
    if (isComponent(name)) {
      if (isObject(value)) components[name] = value as TokenMap;
    } else tokens[name] = value as JsonValue;
  }
  return { tokens, components };
}

export class StyleRegistry {
  private readonly styles = new Map<string, StyleDefinition>();

  constructor(rows: StyleEntry[]) {
    for (const row of rows) if (isObject(row.definition)) this.styles.set(row.style_id, normalizeStyle(row.definition));
  }

  has(styleId: string): boolean {
    return this.styles.has(styleId);
  }

  get(styleId: string): StyleDefinition | undefined {
    return this.styles.get(styleId);
  }

  ids(): string[] {
    return [...this.styles.keys()];
  }

  /** Ancestors first, the style itself last. Unknown parents and cycles end the chain. */
  chain(styleId: string): string[] {
    const out: string[] = [];
    for (let current: string | undefined = styleId; current && this.styles.has(current) && !out.includes(current) && out.length <= MAX_INHERIT_DEPTH;
      current = this.styles.get(current)?.inherit) out.unshift(current);
    return out;
  }

  /** A registry style with everything it inherits. */
  resolve(styleId: string | undefined): ResolvedStyle {
    return (styleId ? this.chain(styleId) : []).reduce((style, id) => mergeStyle(style, this.styles.get(id) as StyleDefinition), emptyStyle());
  }

  /** One cascade step: a referenced style (with its ancestors) then the instance override. */
  apply(base: ResolvedStyle, ref: StyleRef | undefined): ResolvedStyle {
    if (!ref) return base;
    const withStyle = ref.id ? mergeStyle(base, this.resolve(ref.id)) : base;
    return ref.override ? mergeStyle(withStyle, overrideLayer(ref.override)) : withStyle;
  }
}

/** Tokens a component sees: the style's tokens with the component's own on top. */
export function componentTokens(style: ResolvedStyle, component?: StyleComponent): TokenMap {
  return component ? { ...style.tokens, ...style.components[component] } : style.tokens;
}
