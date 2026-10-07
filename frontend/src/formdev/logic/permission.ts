/**
 * Form, section, category and field permissions (Phase 2.8). Twin of
 * services/flora-api/app/formdev/logic/permission.py, held to formdev/spec/fixtures/permission-cases.json.
 *
 * Codes are Flora's RBAC role (or permission) codes. For each action the innermost level that sets a list decides
 * (field -> group -> category -> section -> form); a level without the action inherits it, and nothing set
 * anywhere means allowed. Administrators pass everything.
 */
import { build } from "./model";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

export const FIELD_ACTIONS = ["view", "edit", "export"] as const;
export const FORM_ACTIONS = ["view", "create", "edit", "delete", "export"] as const;
export const RECORD_ACTIONS = ["create", "edit", "delete"] as const;
export const OTHER_KEY = "_other";

export type FieldGrant = { view: boolean; edit: boolean; export: boolean };

/** The innermost list set for `action`, or null (no restriction). */
export function effective(grants: unknown[], action: string): string[] | null {
  for (let index = grants.length - 1; index >= 0; index -= 1) {
    const grant = grants[index];
    if (isObject(grant) && Array.isArray(grant[action])) return (grant[action] as unknown[]).filter((code): code is string => typeof code === "string");
  }
  return null;
}

const allowed = (grants: unknown[], action: string, roles: Set<string>) => {
  const codes = effective(grants, action);
  return codes === null || codes.some(code => roles.has(code));
};

export function formAllows(definition: unknown, action: string, roles: Iterable<string>, isAdmin = false): boolean {
  if (isAdmin) return true;
  const permission = isObject(definition) ? definition.permission : undefined;
  return allowed(isObject(permission) ? [permission] : [], action, new Set(roles));
}

/** node ("bmi", "meds.dose") -> {view, edit, export}. Editing needs viewing, and a repeat can be edited only
 * when every child in it can (items are added, removed and reordered as a whole). */
export function fieldPermissions(definition: unknown, roles: Iterable<string>, isAdmin = false): Record<string, FieldGrant> {
  const roleSet = new Set(roles);
  const out: Record<string, FieldGrant> = {};
  for (const item of build(definition).fields) {
    if (isAdmin) {
      out[item.node] = { view: true, edit: true, export: true };
      continue;
    }
    const view = allowed(item.permissions, "view", roleSet);
    out[item.node] = { view, edit: view && allowed(item.permissions, "edit", roleSet), export: view && allowed(item.permissions, "export", roleSet) };
  }
  for (const [node, granted] of Object.entries(out)) {
    const prefix = `${node}.`;
    if (granted.edit && Object.entries(out).some(([name, child]) => name.startsWith(prefix) && !child.edit)) granted.edit = false;
  }
  return out;
}

/** May the roles create / edit / delete a record? Editing is allowed when at least one field is editable. */
export function recordAllows(definition: unknown, action: string, roles: Iterable<string>, isAdmin = false): boolean {
  if (action !== "edit") return formAllows(definition, action, roles, isAdmin);
  const granted = Object.entries(fieldPermissions(definition, roles, isAdmin)).filter(([node]) => !node.includes("."));
  return granted.length ? granted.some(([, item]) => item.edit) : formAllows(definition, "edit", roles, isAdmin);
}

/** Data keys the roles may not `action`: top-level keys, plus repeat children ("meds.cost") when `nested`. */
export function denied(definition: unknown, action: (typeof FIELD_ACTIONS)[number], roles: Iterable<string>, isAdmin = false, nested = false): Set<string> {
  return new Set(Object.entries(fieldPermissions(definition, roles, isAdmin))
    .filter(([node, granted]) => (nested || !node.includes(".")) && !granted[action])
    .map(([node]) => node));
}

/** Remove hidden keys ("bmi", or "meds.cost" inside each item) and their Other text. */
export function mask(data: unknown, hidden: Set<string>): unknown {
  if (!hidden.size || !isObject(data)) return data;
  const top = new Set([...hidden].filter(key => !key.includes(".")));
  const children = new Map<string, Set<string>>();
  for (const key of hidden) {
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const parent = key.slice(0, dot);
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(key.slice(dot + 1));
  }
  const out: Obj = {};
  for (const [key, value] of Object.entries(data)) {
    if (top.has(key)) continue;
    if (key === OTHER_KEY && isObject(value)) out[key] = Object.fromEntries(Object.entries(value).filter(([name]) => !top.has(name)));
    else if (children.has(key) && Array.isArray(value)) out[key] = value.map(item => mask(item, children.get(key)!));
    else out[key] = value;
  }
  return out;
}
