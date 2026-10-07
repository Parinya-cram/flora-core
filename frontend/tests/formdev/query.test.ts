/** Query validator twin: every shared fixture case must give the same issue codes, severities and paths as Python. */
import { describe, expect, it } from "vitest";
import { validateQuery } from "../../src/formdev/query/validate";
import type { QueryCatalog, QueryPolicy, QueryPrincipal } from "../../src/formdev/query/types";
import { loadJson } from "./helpers";

type Fixture = {
  catalogs: Record<string, QueryCatalog>;
  principals: Record<string, QueryPrincipal>;
  cases: Array<{ name: string; catalog: string; principal: string; body: unknown; errors: string[]; warnings: string[]; paths: string[] }>;
};

const fixture = loadJson<Fixture>("spec/fixtures/query-cases.json");
const policy = loadJson<QueryPolicy>("spec/query-policy.json");

/** Python sorted() on str compares code points. */
const pySorted = (items: string[]) => [...items].sort((a, b) => {
  const x = [...a];
  const y = [...b];
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    const diff = x[index].codePointAt(0)! - y[index].codePointAt(0)!;
    if (diff) return diff;
  }
  return x.length - y.length;
});

/** Mirrors build_query_fixtures.py: the catalog is passed only when the body names its source. */
function run(testCase: Fixture["cases"][number]) {
  const catalog = fixture.catalogs[testCase.catalog];
  const body = testCase.body as { query?: unknown };
  const source = body && typeof body.query === "object" && body.query !== null && !Array.isArray(body.query) ? (body.query as { source?: unknown }).source : undefined;
  return validateQuery(testCase.body, source === catalog.source_id ? catalog : null, fixture.principals[testCase.principal], policy);
}

describe("query fixtures", () => {
  it("covers the shared cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(60);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const issues = run(testCase);
      expect(pySorted(issues.map(issue => `${issue.severity}:${issue.code}:${issue.path}`))).toEqual(testCase.paths);
      expect(issues.filter(issue => issue.severity === "error").map(issue => issue.code).sort()).toEqual(testCase.errors);
      expect(issues.filter(issue => issue.severity === "warning").map(issue => issue.code).sort()).toEqual(testCase.warnings);
      for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
    });
  }
});

describe("query policy file", () => {
  it("has the expected format and sane bounds", () => {
    expect(policy.format).toBe("flora.query-policy/1");
    expect(policy.max_page_rows).toBeGreaterThan(0);
    expect(policy.max_page_rows).toBeLessThanOrEqual(policy.max_groups);
    expect(policy.timeout_ms.default).toBeLessThanOrEqual(policy.timeout_ms.max);
    expect(policy.cache_ttl_s.default).toBeLessThanOrEqual(policy.cache_ttl_s.max);
    expect(policy.export_max_rows.default).toBeLessThanOrEqual(policy.export_max_rows["formdev.manage"]);
    expect(policy.max_in_values).toBeLessThanOrEqual(policy.max_total_values);
    expect(policy.min_prefix_length).toBeGreaterThanOrEqual(1);
    for (const value of [policy.max_offset, policy.max_sort_keys, policy.max_filter_depth, policy.max_filter_leaves, policy.max_index_terms_per_and,
      policy.max_string_length, policy.max_group_keys, policy.max_aggregates, policy.count_cap, policy.max_body_bytes]) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
  });

  it("drives the validator limits", () => {
    const catalog = fixture.catalogs.assessment;
    const clinician = fixture.principals.clinician;
    const body = { query: { source: catalog.source_id, select: ["hn"], filter: { field: "fall_risk", op: "eq", value: "yes" }, pagination: { mode: "cursor", limit: 600 } } };
    expect(validateQuery(body, catalog, clinician, policy).map(issue => issue.code)).toEqual(["limit_exceeded"]);
    expect(validateQuery(body, catalog, clinician, { ...policy, max_page_rows: 1000 })).toEqual([]);
  });

  it("counts string length in code points like Python", () => {
    const catalog = fixture.catalogs.assessment;
    const body = (value: string) => ({ query: { source: catalog.source_id, select: ["hn"], filter: { field: "hn", op: "eq", value }, pagination: { mode: "cursor", limit: 5 } } });
    const emoji = (count: number) => "😀".repeat(count);
    expect(validateQuery(body(emoji(policy.max_string_length)), catalog, fixture.principals.clinician, policy)).toEqual([]);
    expect(validateQuery(body(emoji(policy.max_string_length + 1)), catalog, fixture.principals.clinician, policy).map(issue => `${issue.code}:${issue.path}`)).toEqual(["invalid_value:$.query.filter.value"]);
  });

  it("treats booleans as non-numbers", () => {
    const catalog = fixture.catalogs.assessment;
    const body = { query: { source: catalog.source_id, select: ["hn"], filter: { field: "age", op: "eq", value: true }, pagination: { mode: "cursor", limit: true } } };
    expect(validateQuery(body, catalog, fixture.principals.clinician, policy).map(issue => `${issue.code}:${issue.path}`).sort()).toEqual([
      "invalid_pagination:$.query.pagination.limit", "invalid_value:$.query.filter.value",
    ]);
  });
});

/**
 * Cases outside the shared fixture file. Expected lists were produced by running validator.py on
 * the same bodies (assessment catalog, clinician), so the twins stay pinned until the cases move
 * into query-cases.json.
 */
describe("query validator parity beyond the fixtures", () => {
  const catalog = fixture.catalogs.assessment;
  const clinician = fixture.principals.clinician;
  const paths = (body: unknown) => pySorted(validateQuery(body, catalog, clinician, policy).map(issue => `${issue.severity}:${issue.code}:${issue.path}`));
  const base = { source: catalog.source_id, filter: { field: "fall_risk", op: "eq", value: "yes" } };

  it("rejects any trailing newline after a datetime (Python patterns end with \\Z)", () => {
    const created = (value: string) => ({ query: { source: catalog.source_id, select: ["$record_id"], filter: { field: "$created_at", op: "gte", value }, pagination: { limit: 10 } } });
    expect(paths(created("2025-01-01T00:00:00Z"))).toEqual([]);
    for (const value of ["2025-01-01T00:00:00Z\n", "2025-01-01T00:00:00Z\n\n", "2025-01-01T00:00:00Z\r\n"]) {
      expect(paths(created(value))).toEqual(["error:invalid_value:$.query.filter.value"]);
    }
    const between = { query: { ...base, select: ["hn"], filter: { field: "assessed_at", op: "between", value: ["2026-10-01T00:00\n", "2026-10-02T00:00:00+07:00"] }, pagination: { mode: "cursor", limit: 10 } } };
    expect(paths(between)).toEqual(["error:invalid_value:$.query.filter.value[0]"]);
  });

  // Non-string operators, functions, buckets and grouped sort names are issues, not crashes
  // (validator.py guards each membership test with isinstance(..., str)).
  it("reports non-string operators, functions, buckets and grouped sort names as issues", () => {
    expect(paths({ query: { ...base, select: ["hn"], filter: { field: "hn", op: ["eq"], value: "x" }, pagination: { mode: "cursor", limit: 10 } } }))
      .toEqual(["error:invalid_operator:$.query.filter.op"]);
    expect(paths({ query: { ...base, aggregate: [{ fn: ["count"], as: "n" }], pagination: { mode: "offset", limit: 10 } } }))
      .toEqual(["error:aggregate_invalid:$.query.aggregate[0].fn"]);
    expect(paths({ query: { ...base, group: [{ field: "$created_at", bucket: ["day"] }], aggregate: [{ fn: "count", as: "n" }], pagination: { mode: "offset", limit: 10 } } }))
      .toEqual(["error:aggregate_invalid:$.query.group[0].bucket"]);
    expect(paths({ query: { ...base, group: ["hn"], aggregate: [{ fn: "count", as: "n" }], sort: [{ field: ["hn"] }], pagination: { mode: "offset", limit: 10 } } }))
      .toEqual(["error:sort_not_grouped:$.query.sort[0].field"]);
  });
});
