import { describe, expect, it } from "vitest";
import type { CatalogField } from "../../src/api/reportStudioApi";
import { aggregatesFor, canDrop, defaultShelf, emptySpec, insertField, moveItem, problems, removeItem, switchView, updateItem } from "../../src/reportstudio/model";

const field = (id: string, data_type: CatalogField["data_type"], allowed_uses: CatalogField["allowed_uses"], extra: Partial<CatalogField> = {}): CatalogField => ({
  id, dataset_id: "innovian_cases", label: id, description: "", section: "Case", data_type, cardinality: "scalar", allowed_uses,
  operators: ["equals", "in", "between", "greater_than", "contains"], ...extra,
});
const started = field("case.started_at", "datetime", ["filter", "result", "group"], { operators: ["between", "after"] });
const asa = field("patient.asa_status", "category", ["filter", "result", "group"], { operators: ["in", "equals", "is_empty"] });
const name = field("patient.name", "text", ["filter", "result"], { operators: ["contains", "equals"] });
const duration = field("case.duration_minutes", "duration", ["filter", "result", "group", "measure"], { operators: ["greater_than", "between"] });
const technique = field("anesthesia.technique", "category", ["filter", "result", "group"], { cardinality: "multi", operators: ["in", "contains_all"] });
const fields = new Map([started, asa, name, duration, technique].map(item => [item.id, item]));

describe("report studio model", () => {
  it("only accepts fields on shelves their catalog uses allow", () => {
    expect(canDrop(name, "groups")).toBe(false);
    expect(canDrop(name, "columns")).toBe(true);
    expect(canDrop(duration, "measures")).toBe(true);
    expect(canDrop(asa, "measures")).toBe(true); // as "cases with a value"
    expect(insertField(emptySpec("stats"), name, { shelf: "groups", index: 0 }).groups).toEqual([]);
  });

  it("gives dropped fields sensible defaults", () => {
    let spec = insertField(emptySpec("stats"), started, { shelf: "groups", index: 0 });
    expect(spec.groups[0]).toEqual({ field: "case.started_at", bucket: "month" });
    spec = insertField(spec, duration, { shelf: "measures", index: 1 });
    expect(spec.measures[1]).toEqual({ field: "case.duration_minutes", agg: "avg" });
    spec = insertField(spec, asa, { shelf: "filters", index: 0 });
    expect(spec.filters[0]).toEqual({ field: "patient.asa_status", op: "in", value: [] });
    spec = insertField(spec, started, { shelf: "filters", index: 1 });
    expect(spec.filters[1]).toEqual({ field: "case.started_at", op: "between", value: ["", ""] });
  });

  it("clicks add numbers as statistics and categories as groups", () => {
    expect(defaultShelf(duration, "stats")).toBe("measures");
    expect(defaultShelf(asa, "stats")).toBe("groups");
    expect(defaultShelf(name, "stats")).toBe("filters");
    expect(defaultShelf(name, "list")).toBe("columns");
  });

  it("reorders within a shelf and converts across shelves", () => {
    let spec = { ...emptySpec("stats"), groups: [{ field: "case.started_at", bucket: "month" as const }, { field: "patient.asa_status" }] };
    spec = moveItem(spec, { shelf: "groups", index: 0 }, { shelf: "groups", index: 2 }, fields);
    expect(spec.groups.map(item => item.field)).toEqual(["patient.asa_status", "case.started_at"]);
    spec = moveItem(spec, { shelf: "groups", index: 0 }, { shelf: "filters", index: 0 }, fields);
    expect(spec.groups.map(item => item.field)).toEqual(["case.started_at"]);
    expect(spec.filters[0].field).toBe("patient.asa_status");
    // name cannot be a group: the move is refused and nothing is lost
    const listSpec = { ...emptySpec("stats"), filters: [{ field: "patient.name", op: "contains", value: "x" }] };
    expect(moveItem(listSpec, { shelf: "filters", index: 0 }, { shelf: "groups", index: 0 }, fields)).toBe(listSpec);
  });

  it("clears the sort when the shape changes and keeps it on edits", () => {
    const spec = { ...emptySpec("stats"), groups: [{ field: "patient.asa_status" }], sort: { key: "m0", dir: "desc" as const } };
    expect(removeItem(spec, { shelf: "groups", index: 0 }).sort).toBeNull();
    expect(updateItem(spec, { shelf: "groups", index: 0 }, { label: "ASA" }).sort).toEqual({ key: "m0", dir: "desc" });
  });

  it("reports filters without values and empty case lists", () => {
    const spec = { ...emptySpec("list"), filters: [{ field: "patient.asa_status", op: "in", value: [] }, { field: "patient.asa_status", op: "is_empty", value: null },
      { field: "case.started_at", op: "between", value: ["2026-01-01", ""] }] };
    const found = problems(spec, fields);
    expect(found.map(item => item.slot?.index ?? -1)).toEqual([-1, 0, 2]);
  });

  it("carries fields across when switching between list and statistics", () => {
    const list = { ...emptySpec("list"), columns: [{ field: "patient.name" }, { field: "patient.asa_status" }, { field: "case.started_at" }] };
    const stats = switchView(list, "stats", fields);
    expect(stats.groups).toEqual([{ field: "patient.asa_status" }, { field: "case.started_at", bucket: "month" }]);
    expect(stats.measures).toEqual([{ agg: "count_cases" }]);
    expect(switchView(stats, "list", fields).columns).toEqual([{ field: "patient.asa_status" }, { field: "case.started_at" }]);
  });

  it("offers numeric statistics only for number fields", () => {
    expect(aggregatesFor(duration)).toContain("median");
    expect(aggregatesFor(asa)).toEqual(["count_filled"]);
    expect(aggregatesFor(technique)).toEqual(["count_filled"]);
  });
});
