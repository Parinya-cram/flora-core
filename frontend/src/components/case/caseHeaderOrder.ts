/** Order of the case summary cards (Chart and every case page), and whether the other case pages show them in full,
 * kept per user in this browser. */
export type CaseHeaderCardId = "los" | "patient" | "allergy" | "diagnosis" | "operation";
export const DEFAULT_CASE_HEADER_ORDER: CaseHeaderCardId[] = ["los", "patient", "allergy", "diagnosis", "operation"];

export function caseHeaderOrderStorageKey(username: string) {
  return `flora.caseHeaderOrder.${username || "default"}`;
}

export function readCaseHeaderOrder(username: string): CaseHeaderCardId[] {
  if (typeof window === "undefined") return DEFAULT_CASE_HEADER_ORDER;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(caseHeaderOrderStorageKey(username)) || "[]") as unknown[];
    const allowed = new Set<CaseHeaderCardId>(DEFAULT_CASE_HEADER_ORDER);
    const valid = parsed.filter((value): value is CaseHeaderCardId => allowed.has(value as CaseHeaderCardId));
    return valid.length === DEFAULT_CASE_HEADER_ORDER.length && new Set(valid).size === valid.length
      ? valid
      : DEFAULT_CASE_HEADER_ORDER;
  } catch {
    return DEFAULT_CASE_HEADER_ORDER;
  }
}

export function caseHeaderExpandedStorageKey(username: string) {
  return `flora.caseHeaderExpanded.${username || "default"}`;
}

/** Case pages other than the Chart show the summary as one line unless the user opened the cards. */
export function readCaseHeaderExpanded(username: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(caseHeaderExpandedStorageKey(username)) === "1";
  } catch {
    return false;
  }
}

export function writeCaseHeaderExpanded(username: string, expanded: boolean) {
  try {
    window.localStorage.setItem(caseHeaderExpandedStorageKey(username), expanded ? "1" : "0");
  } catch {
    // Not kept (private window or storage blocked): the strip still toggles for this page.
  }
}

export function isNkaAllergen(value: unknown): boolean {
  const normalized = String(value || "").replace(/[^a-z]/gi, "").toUpperCase();
  return normalized === "NKA" || normalized === "NKDA" || normalized === "NOKNOWNALLERGY" || normalized === "NOKNOWNDRUGALLERGY" || normalized === "NOKNOWNALLERGIES";
}
