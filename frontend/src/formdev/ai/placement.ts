/**
 * Where a workflow form is filled in on Flora Leaf: the case phase and the built-in anaesthesia record tab it follows.
 * The tab list mirrors services/flora-api/app/workflows.py SECTIONS (Workflow Studio serves the same list).
 */
import type { FormDefinition } from "../core/types";
import { PLACEMENT_KEY, type Placement } from "./types";

export const LEAF_TABS: Array<{ id: string; label: string }> = [
  { id: "caseInfo", label: "Case & Plan" }, { id: "preop", label: "Pre-anesthesia" }, { id: "checklist", label: "Safety Checklist" },
  { id: "ga_ett", label: "GA ETT" }, { id: "ga_lma", label: "GA LMA" }, { id: "ga_tubeless", label: "GA Tubeless" },
  { id: "neuraxial", label: "Neuraxial Block" }, { id: "pnb", label: "PNB" }, { id: "line", label: "Line" }, { id: "comorbid", label: "Comorbid" },
  { id: "extubation", label: "Extubation" }, { id: "pacu", label: "Recovery / PACU" }, { id: "pain", label: "Pain" }, { id: "outcome", label: "Outcome" },
];

export const PHASE_LABEL: Record<Placement["phase"], [string, string]> = {
  preop: ["ก่อนผ่าตัด", "Pre-op"], intraop: ["ระหว่างผ่าตัด", "Intra-op"], postop: ["หลังผ่าตัด", "Post-op"], any: ["ทุกช่วง", "Any time"],
};

export function tabLabel(id: string | null | undefined): string | null {
  return id ? LEAF_TABS.find(tab => tab.id === id)?.label ?? id : null;
}

/** The placement suggested in the form (extensions["flora.leaf_placement"]), when it is well formed. */
export function suggestedPlacement(definition: FormDefinition | null | undefined): Placement | null {
  const value = (definition?.extensions as Record<string, unknown> | undefined)?.[PLACEMENT_KEY];
  if (!value || typeof value !== "object") return null;
  const { phase, after_section: after } = value as { phase?: unknown; after_section?: unknown };
  if (typeof phase !== "string" || !(phase in PHASE_LABEL)) return null;
  return { phase: phase as Placement["phase"], after_section: typeof after === "string" && LEAF_TABS.some(tab => tab.id === after) ? after : null };
}

/** The form with its Leaf placement set (or removed when null). */
export function withPlacement(definition: FormDefinition, placement: Placement | null): FormDefinition {
  const extensions = { ...((definition.extensions as Record<string, unknown> | undefined) ?? {}) };
  if (placement) extensions[PLACEMENT_KEY] = { phase: placement.phase, after_section: placement.after_section };
  else delete extensions[PLACEMENT_KEY];
  return { ...definition, extensions: extensions as FormDefinition["extensions"] };
}
