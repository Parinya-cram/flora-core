/** Query builders: the fluent API and the visual-builder reducer both emit bodies the validator accepts. */
import { describe, expect, it } from "vitest";
import {
  and, avg, between, builderReducer, CONDITION_METADATA, conditionChoices, conditionFamily, conditionOperators, conditionValue, count, editCondition, eq, gte,
  initialBuilderState, inList, isNotNull, isNull, lt, max, ne, not, or, prefix, query, stateToQuery,
  type BuilderAction, type BuilderState,
} from "../../src/formdev/query/builder";
import { validateQuery } from "../../src/formdev/query/validate";
import type { FilterOp, QueryBody, QueryCatalog, QueryPolicy, QueryPrincipal } from "../../src/formdev/query/types";
import { loadJson } from "./helpers";

const fixture = loadJson<{ catalogs: Record<string, QueryCatalog>; principals: Record<string, QueryPrincipal> }>("spec/fixtures/query-cases.json");
const policy = loadJson<QueryPolicy>("spec/query-policy.json");
const catalog = fixture.catalogs.assessment;
const clinician = fixture.principals.clinician;
const issues = (body: QueryBody) => validateQuery(body, catalog, clinician, policy).map(issue => `${issue.severity}:${issue.code}:${issue.path}`).sort();
const run = (actions: BuilderAction[], start: BuilderState = initialBuilderState("patient_assessment")) => actions.reduce(builderReducer, start);

describe("fluent query builder", () => {
  it("refuses empty and()/or() and collapses a single filter to itself", () => {
    expect(() => and()).toThrow(/at least one filter/);
    expect(() => or(...[])).toThrow(/at least one filter/);
    expect(and(eq("hn", "HN1"))).toEqual({ field: "hn", op: "eq", value: "HN1" });
    expect(or(gte("age", 65))).toEqual({ field: "age", op: "gte", value: 65 });
    expect(not(and(eq("hn", "HN1")))).toEqual({ not: { field: "hn", op: "eq", value: "HN1" } });
    const body = query("one").from("patient_assessment").select("hn").where(and(eq("fall_risk", "yes"))).cursor(10).build();
    expect(body.query.filter).toEqual({ field: "fall_risk", op: "eq", value: "yes" });
    expect(issues(body)).toEqual([]);
  });

  it("builds the documented example as plain JSON", () => {
    const body = query("patient_list").from("patient_assessment").select("hn", "age")
      .where(and(eq("fall_risk", "yes"), gte("age", 65))).orderBy("$updated_at", "desc").cursor(50).build();
    expect(body).toEqual({
      format: "flora.query/1",
      query: {
        id: "patient_list", source: "patient_assessment", select: ["hn", "age"],
        filter: { and: [{ field: "fall_risk", op: "eq", value: "yes" }, { field: "age", op: "gte", value: 65 }] },
        sort: [{ field: "$updated_at", dir: "desc" }], pagination: { mode: "cursor", limit: 50 },
      },
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    expect(issues(body)).toEqual(["warning:cursor_not_snapshot_stable:$.query.sort[0].field"]);
  });

  it("produces bodies that validate clean for every helper", () => {
    const bodies = [
      query().from("patient_assessment").select("hn", "full_name", "patient.name")
        .where(or(inList("hn", ["HN1", "HN2"]), prefix("hn", "HN9"), and(ne("fall_risk", "no"), lt("age", 90)), not(eq("smoker", true))))
        .cursor(20).build(),
      query().from("patient_assessment").select("hn").where(and(isNull("bmi"), isNotNull("age"), between("assessed_at", "2026-10-01T00:00:00+07:00", "2026-10-31T23:59:59+07:00")))
        .orderBy("age", "asc").offset(20, 40).withCount().timeout(4000).cache(60).build(),
      query().from("patient_assessment").select("hn").where(eq("$status", "submitted")).orderBy("$created_at", "desc").cursor(10, "opaque-cursor").cache(false)
        .export({ format: "csv", headers: "labels", max_rows: 5000 }).build(),
      query("risk_by_status").from("patient_assessment").groupBy("fall_risk", "$status").aggregate(count("n"), avg("age", "avg_age"), max("assessed_at", "latest"))
        .orderBy("n", "desc").offset(100).build(),
      query().from("patient_assessment").groupBy({ field: "$ingested_at", bucket: "day", tz_offset_minutes: 420 }).aggregate(count("n")).build(),
    ];
    for (const body of bodies) expect(issues(body)).toEqual([]);
  });

  it("reports what the builder cannot prevent", () => {
    expect(issues(query().from("patient_assessment").select("hn").where(eq("age", 70)).orderBy("age").cursor(10).build()))
      .toEqual(["error:cursor_requires_stable_sort:$.query.sort[0].field"]);
    expect(() => query().select("hn").build()).toThrow();
  });

  it("returns a copy that later calls do not change", () => {
    const builder = query().from("patient_assessment").select("hn").where(eq("fall_risk", "yes")).cursor(10);
    const first = builder.build();
    builder.select("age");
    expect(first.query.select).toEqual(["hn"]);
    expect(builder.build().query.select).toEqual(["hn", "age"]);
  });
});

describe("visual builder reducer", () => {
  it("builds a list query from UI actions", () => {
    const state = run([
      { type: "toggleField", field: "hn" },
      { type: "toggleField", field: "age" },
      { type: "toggleField", field: "full_name" },
      { type: "toggleField", field: "full_name" },
      { type: "addGroup" },
      { type: "addCondition", group: 0 },
      { type: "updateCondition", group: 0, index: 0, patch: { field: "fall_risk", value: "yes" } },
      { type: "addGroup", combinator: "or" },
      { type: "addCondition", group: 1, condition: { field: "age", op: "gte", value: 65 } },
      { type: "addCondition", group: 1, condition: { field: "bmi", op: "is_null" } },
      { type: "setSort", sort: { field: "$created_at", dir: "desc" } },
      { type: "setPagination", limit: 25 },
    ]);
    const body = stateToQuery(state);
    expect(body).toEqual({
      format: "flora.query/1",
      query: {
        source: "patient_assessment", select: ["hn", "age"],
        filter: { and: [{ field: "fall_risk", op: "eq", value: "yes" }, { or: [{ field: "age", op: "gte", value: 65 }, { field: "bmi", op: "is_null" }] }] },
        sort: [{ field: "$created_at", dir: "desc" }], pagination: { mode: "cursor", limit: 25 },
      },
    });
    expect(issues(body)).toEqual([]);
  });

  it("emits one condition as a leaf and drops empty groups", () => {
    const state = run([
      { type: "toggleField", field: "hn" },
      { type: "addGroup", combinator: "or" },
      { type: "addGroup" },
      { type: "addCondition", group: 1, condition: { field: "hn", op: "prefix", value: "HN" } },
      { type: "addGroup" },
      { type: "addCondition", group: 2 },
    ]);
    expect(stateToQuery(state).query.filter).toEqual({ field: "hn", op: "prefix", value: "HN" });
    const none = run([{ type: "toggleField", field: "hn" }, { type: "addGroup" }]);
    expect(stateToQuery(none).query).not.toHaveProperty("filter");
    expect(issues(stateToQuery(none))).toEqual(["warning:missing_filter:$.query.filter"]);
  });

  it("uses the group combinator for several conditions", () => {
    const state = run([
      { type: "addGroup" },
      { type: "addCondition", group: 0, condition: { field: "hn", op: "eq", value: "HN1" } },
      { type: "addCondition", group: 0, condition: { field: "hn", op: "eq", value: "HN2" } },
      { type: "setCombinator", group: 0, combinator: "or" },
    ]);
    expect(stateToQuery(state).query.filter).toEqual({ or: [{ field: "hn", op: "eq", value: "HN1" }, { field: "hn", op: "eq", value: "HN2" }] });
    const removed = run([{ type: "removeCondition", group: 0, index: 0 }], state);
    expect(stateToQuery(removed).query.filter).toEqual({ field: "hn", op: "eq", value: "HN2" });
    expect(stateToQuery(run([{ type: "removeGroup", group: 0 }], state)).query).not.toHaveProperty("filter");
  });

  it("drops the value when an operator takes none", () => {
    const state = run([
      { type: "addGroup" },
      { type: "addCondition", group: 0, condition: { field: "bmi", op: "eq", value: 20 } },
      { type: "updateCondition", group: 0, index: 0, patch: { op: "is_not_null" } },
    ]);
    expect(state.groups[0].conditions[0]).toEqual({ field: "bmi", op: "is_not_null" });
    expect(stateToQuery(state).query.filter).toEqual({ field: "bmi", op: "is_not_null" });
  });

  it("builds grouped queries with offset paging and no select", () => {
    const state = run([
      { type: "toggleField", field: "hn" },
      { type: "setGroupBy", fields: ["fall_risk"] },
      { type: "addAggregate", aggregate: { fn: "count", as: "n" } },
      { type: "addAggregate", aggregate: { fn: "avg", field: "age", as: "avg_age" } },
      { type: "addAggregate", aggregate: { fn: "max", field: "age", as: "oldest" } },
      { type: "removeAggregate", index: 2 },
      { type: "setSort", sort: { field: "n", dir: "desc" } },
      { type: "setPagination", limit: 100 },
    ]);
    const body = stateToQuery(state);
    expect(body.query).toEqual({
      source: "patient_assessment", group: ["fall_risk"], aggregate: [{ fn: "count", as: "n" }, { fn: "avg", field: "age", as: "avg_age" }],
      sort: [{ field: "n", dir: "desc" }], pagination: { mode: "offset", limit: 100, offset: 0 },
    });
    expect(issues(body)).toEqual([]);
  });

  it("switches between cursor and offset paging", () => {
    const offset = run([{ type: "toggleField", field: "hn" }, { type: "setSort", sort: { field: "age", dir: "asc" } }, { type: "setPagination", mode: "offset", limit: 20, offset: 60 }, { type: "setCount", count: "capped" }]);
    expect(stateToQuery(offset).query).toMatchObject({ pagination: { mode: "offset", limit: 20, offset: 60 }, count: "capped" });
    expect(issues(stateToQuery(offset))).toEqual(["warning:missing_filter:$.query.filter"]);
    const cursor = run([{ type: "setPagination", mode: "cursor" }], offset);
    expect([cursor.offset, stateToQuery(cursor).query.pagination]).toEqual([0, { mode: "cursor", limit: 20 }]);
  });

  it("clears field choices when the source changes and resets", () => {
    const state = run([{ type: "toggleField", field: "hn" }, { type: "addGroup" }, { type: "setGroupBy", fields: ["hn"] }, { type: "setPagination", limit: 10 }]);
    const moved = builderReducer(state, { type: "setSource", source: "patient" });
    expect(moved).toMatchObject({ source: "patient", select: [], groups: [], group: [], aggregates: [], sort: null, limit: 10 });
    expect(builderReducer(state, { type: "setSource", source: "patient_assessment" })).toBe(state);
    expect(builderReducer(state, { type: "reset" })).toEqual(initialBuilderState("patient_assessment"));
    expect(builderReducer(state, { type: "updateCondition", group: 5, index: 0, patch: { field: "x" } })).toBe(state);
  });

  it("never mutates the previous state", () => {
    const start = initialBuilderState("patient_assessment");
    const snapshot = JSON.stringify(start);
    run([{ type: "toggleField", field: "hn" }, { type: "addGroup" }, { type: "addCondition", group: 0 }, { type: "updateCondition", group: 0, index: 0, patch: { field: "hn" } }], start);
    expect(JSON.stringify(start)).toBe(snapshot);
  });
});

describe("visual builder condition fields", () => {
  const ALL_OPS: FilterOp[] = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "between", "prefix", "is_null", "is_not_null"];
  // What a user would type into the Value box for each family (datetime-local inputs give 16 characters).
  const SAMPLE: Record<string, [string, string]> = {
    text: ["HN-0001", "HN-0002"], subject: ["HN-0001", "HN-0002"], status: ["draft", "submitted"], num: ["18", "65"], bool: ["true", "false"],
    datetime: ["2026-10-01T08:00", "2026-10-31T23:59:59+07:00"], time: ["2026-10-01T08:00", "2026-10-31T23:59:59+07:00"],
  };
  const typeOf = (field: string) => catalog.fields[field]?.type;
  // Builds a one-condition query the way QueryPanel does (editCondition on every change) and reports its validator errors.
  const errorsFor = (field: string, op: FilterOp, raw: string) => {
    const start = run([{ type: "toggleField", field: "hn" }, { type: "addGroup" }, { type: "addCondition", group: 0 }]);
    const condition = start.groups[0].conditions[0];
    let state = builderReducer(start, { type: "updateCondition", group: 0, index: 0, patch: editCondition(condition, { field }, "", typeOf(field)) });
    state = builderReducer(state, { type: "updateCondition", group: 0, index: 0, patch: editCondition(state.groups[0].conditions[0], { op }, raw, typeOf(field)) });
    return validateQuery(stateToQuery(state), catalog, clinician, policy).filter(issue => issue.severity === "error").map(issue => issue.code);
  };
  const sampleFor = (family: string, op: FilterOp) => {
    const [low, high] = SAMPLE[family];
    return op === "in" || op === "between" ? `${low}, ${high}` : low;
  };

  it("maps $metadata to its real family instead of a number", () => {
    expect(CONDITION_METADATA.map(name => conditionFamily(name))).toEqual(["status", "time", "time", "time", "subject"]);
    expect(conditionFamily("$status", undefined)).toBe("status");
    expect(conditionValue("status", "eq", "submitted")).toBe("submitted");
    expect(conditionValue("subject", "in", "HN-0001, HN-0002")).toEqual(["HN-0001", "HN-0002"]);
    expect(conditionValue("time", "between", "2026-10-01T08:00, 2026-10-02T08:00")).toEqual(["2026-10-01T08:00:00", "2026-10-02T08:00:00"]);
    expect(conditionValue("num", "eq", "65")).toBe(65);
    expect(conditionOperators("status")).toEqual(["eq", "ne", "in"]);
    expect(conditionOperators("longtext")).toEqual([]);
  });

  it("runs the documented metadata filters a user types into the panel", () => {
    expect(errorsFor("$status", "eq", "submitted")).toEqual([]);
    expect(errorsFor("$subject_id", "eq", "HN-0001")).toEqual([]);
    expect(errorsFor("$created_at", "gte", "2026-10-05T08:00:00+07:00")).toEqual([]);
    expect(errorsFor("$updated_at", "between", "2026-10-01T00:00, 2026-10-31T23:59")).toEqual([]);
    expect(errorsFor("$ingested_at", "lt", "2026-10-05T08:00")).toEqual([]);
    expect(errorsFor("$status", "eq", "archived")).toEqual(["invalid_value"]);
  });

  it("offers exactly the operators the validator accepts for every condition field", () => {
    // QueryPanel lists ready indexed fields only; any other field fails with index_required/index_building whatever the operator.
    const fields = [...Object.entries(catalog.fields).filter(([, info]) => info.indexed && info.state !== "building").map(([id]) => id), ...CONDITION_METADATA];
    for (const field of fields) {
      const family = conditionFamily(field, typeOf(field));
      const offered = conditionOperators(family);
      if (!SAMPLE[family]) {
        expect(offered, field).toEqual([]);
        continue;
      }
      for (const op of ALL_OPS) {
        const errors = errorsFor(field, op, sampleFor(family, op));
        expect(errors.length === 0, `${field} ${op} (${errors.join(",") || "accepted"})`).toBe(offered.includes(op));
      }
    }
  });

  it("keeps a valid operator when the field changes and replaces one the new field does not take", () => {
    const condition = { field: "age", op: "lt" as FilterOp, value: 70 };
    expect(editCondition(condition, { field: "$status" }, "submitted", undefined)).toEqual({ field: "$status", op: "eq", value: "submitted" });
    expect(editCondition(condition, { field: "$created_at" }, "2026-10-05T08:00", undefined)).toEqual({ field: "$created_at", op: "lt", value: "2026-10-05T08:00:00" });
    expect(editCondition({ field: "hn", op: "is_null" }, { field: "$created_at" }, "", undefined).op).toBe("gte");
  });

  it("lists status choices, with deleted only for administrators", () => {
    expect(conditionChoices("status", clinician)).toEqual(["draft", "submitted"]);
    expect(conditionChoices("status", fixture.principals.admin)).toEqual(["draft", "submitted", "deleted"]);
    expect(conditionChoices("bool", clinician)).toEqual(["true", "false"]);
    expect(conditionChoices("text", clinician)).toBeNull();
  });
});
