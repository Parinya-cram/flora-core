/**
 * Declarative, non-destructive record migration. Twin of app/formdev/migration.py:
 * removed or unconvertible values move to data._retired, nothing is dropped.
 */
import { RETIRED_KEY } from "./validate";
import { FormDevError, type FormDefinition, type JsonValue, type MigrationOp, type RecordData } from "./types";

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const FAILED = Symbol("conversion-failed");

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export function convert(value: JsonValue, target: "text" | "number" | "integer" | "boolean"): JsonValue | typeof FAILED {
  if (value === null) return null;
  const isNum = typeof value === "number" && Number.isFinite(value);
  if (target === "text") {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "true" : "false";
    return isNum ? String(value) : FAILED;
  }
  if (target === "number") {
    if (isNum) return value;
    if (typeof value === "string" && DECIMAL.test(value.trim())) return Number(value.trim());
    return FAILED;
  }
  if (target === "integer") {
    if (isNum && Number.isInteger(value)) return value;
    if (typeof value === "string" && INTEGER.test(value.trim())) return Number(value.trim());
    return FAILED;
  }
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return FAILED;
}

export function applyOps(data: RecordData, ops: MigrationOp[]): RecordData {
  const out = clone(data);
  const retired: Record<string, JsonValue> = { ...((out[RETIRED_KEY] as Record<string, JsonValue> | undefined) || {}) };
  delete out[RETIRED_KEY];
  for (const op of ops) {
    if (op.op === "rename_field") {
      if (op.from in out) {
        out[op.to] = out[op.from];
        delete out[op.from];
      }
    } else if (op.op === "add_field") {
      if (!(op.field in out)) out[op.field] = op.default === undefined ? null : clone(op.default);
    } else if (op.op === "remove_field") {
      if (op.field in out) {
        retired[op.field] = out[op.field];
        delete out[op.field];
      }
    } else if (op.op === "map_values") {
      if (op.field in out) {
        const mapped = (item: JsonValue) => (typeof item === "string" && Object.prototype.hasOwnProperty.call(op.mapping, item) ? op.mapping[item] : item);
        const value = out[op.field];
        if (Array.isArray(value)) out[op.field] = value.map(mapped);
        else if (typeof value === "string") out[op.field] = mapped(value);
      }
    } else if (op.op === "convert_type") {
      if (op.field in out) {
        const converted = convert(out[op.field], op.to);
        if (converted === FAILED) {
          retired[op.field] = out[op.field];
          out[op.field] = null;
        } else out[op.field] = converted;
      }
    } else {
      throw new FormDevError("invalid_migration", `Unknown migration op '${(op as { op: string }).op}'`);
    }
  }
  if (Object.keys(retired).length) out[RETIRED_KEY] = retired;
  return out;
}

/** Upgrade data through every intermediate version (v1 -> v2 -> v3 ...). */
export function migrate(data: RecordData, fromVersion: number, toVersion: number, loadDefinition: (version: number) => FormDefinition): RecordData {
  if (toVersion < fromVersion) throw new FormDevError("downgrade_not_supported", "Records cannot be migrated to an older schema version");
  let out = clone(data);
  for (let version = fromVersion + 1; version <= toVersion; version += 1) {
    out = applyOps(out, loadDefinition(version).migration?.ops || []);
  }
  return out;
}
