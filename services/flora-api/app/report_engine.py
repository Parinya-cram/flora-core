"""Report Studio query compiler.

A studio report is a JSON spec that names catalog fields (canopy_report_field) and never
carries SQL. This module turns that spec into one parameterised query over the Innovian
archive: every column, table and function comes from the whitelists below and every
user-supplied value is a bound parameter.

Spec (definition.studio):
  view      "list" (one row per case) | "stats" (grouped statistics)
  columns   [{field, label?}]                                  list view
  groups    [{field, bucket?, label?}]                         stats view, bucket for dates
  measures  [{agg, field?, label?}]                            stats view
  filters   [{field, op, value?}]                              both views, all must match
  sort      {key, dir}  key = c<n> | g<n> | m<n>               optional
  limit     top-N groups                                       stats view, optional

Multi-value fields (staff, form components, forms) fan out when grouped: a case is counted
once in every group it has a value for, as the prebuilt monthly reports do.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException

CASE_COLUMNS = {"started_at", "completed_at"}
CONTEXT_COLUMNS = {
    "hn", "encounter_number", "patient_name", "gender", "asa_status", "order_number", "procedure_code",
    "procedure_name", "diagnosis_code", "diagnosis_name", "case_type", "care_unit", "location",
}
DERIVED = {
    "case_duration_minutes": "round(extract(epoch FROM (a.completed_at-a.started_at))/60)",
    "age_years": "date_part('year', age(a.started_at, c.date_of_birth))",
    "staff_count": "(SELECT count(*) FROM archive_staff_assignment s WHERE s.archive_case_id=a.id AND NOT s.source_deleted)",
}
REPORT_STATUS = """(SELECT CASE WHEN count(*) FILTER(WHERE r.expected)=0 THEN 'not_classified'
  WHEN count(*) FILTER(WHERE r.expected AND r.file_path IS NULL)=0 THEN 'complete' ELSE 'incomplete' END
  FROM archive_case_report r WHERE r.archive_case_id=a.id)"""
DECODED = "coalesce(nullif(ff.value#>>'{selected,0,label}',''),nullif(ff.value->>'text',''),nullif(ff.value->>'value',''),nullif(ff.raw_value,''))"

BUCKETS = {
    "day": ("day", "YYYY-MM-DD"),
    "week": ("week", "IYYY-\"W\"IW"),
    "month": ("month", "YYYY-MM"),
    "quarter": ("quarter", "YYYY-\"Q\"Q"),
    "year": ("year", "YYYY"),
}
NUMERIC_AGGS = {"avg", "median", "p90", "min", "max", "sum", "stddev"}
COUNT_AGGS = {"count_cases", "count_patients", "pct_cases", "count_filled"}
AGG_LABELS = {
    "count_cases": "Cases", "count_patients": "Patients", "pct_cases": "% of cases", "count_filled": "Cases with",
    "avg": "Average", "median": "Median", "p90": "90th percentile", "min": "Minimum", "max": "Maximum",
    "sum": "Total", "stddev": "Std. deviation",
}
MAX_COLUMNS = 30
MAX_GROUPS = 3
MAX_MEASURES = 12
MAX_FILTERS = 20


def _bad(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def _like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@dataclass
class Compiled:
    sql: str
    params: dict[str, Any]
    columns: list[dict[str, Any]]
    order_by: str
    view: str
    limit: int | None = None
    filtered: str = ""


@dataclass
class _Builder:
    fields: dict[str, dict[str, Any]]
    options: dict[str, list[dict[str, Any]]]
    params: dict[str, Any] = field(default_factory=dict)
    labels: set[str] = field(default_factory=set)

    def bind(self, value: Any) -> str:
        name = f"p{len(self.params)}"
        self.params[name] = value
        return f"%({name})s"

    def label(self, wanted: str) -> str:
        text, n = wanted.strip() or "Column", 2
        candidate = text
        while candidate.lower() in self.labels:
            candidate, n = f"{text} ({n})", n + 1
        self.labels.add(candidate.lower())
        return candidate

    def field(self, field_id: Any, use: str) -> dict[str, Any]:
        row = self.fields.get(str(field_id or ""))
        if not row:
            raise _bad(f"Unknown report field: {field_id}")
        if use not in (row.get("allowed_uses") or []):
            raise _bad(f"{row['label']} cannot be used as a {use}")
        return row

    # Expressions --------------------------------------------------------------------------
    def scalar(self, row: dict[str, Any]) -> str:
        config = row.get("source_config") or {}
        resolver = config.get("resolver")
        if resolver == "case_column" and config.get("column") in CASE_COLUMNS:
            return f"a.{config['column']}"
        if resolver == "context_column" and config.get("column") in CONTEXT_COLUMNS:
            return f"c.{config['column']}"
        if resolver == "derived" and config.get("formula") in DERIVED:
            return DERIVED[config["formula"]]
        if resolver == "case_report_status":
            return REPORT_STATUS
        raise _bad(f"{row['label']} has an unsupported source")

    def values(self, row: dict[str, Any]) -> str:
        """SELECT of the field's values (column v) for the current case a.id; multi-value fields only."""
        config = row.get("source_config") or {}
        resolver = config.get("resolver")
        if resolver == "staff_assignment" and config.get("column") in {"display_name", "role"}:
            column = config["column"]
            return f"SELECT s.{column} AS v FROM archive_staff_assignment s WHERE s.archive_case_id=a.id AND NOT s.source_deleted AND nullif(btrim(s.{column}),'') IS NOT NULL"
        if resolver == "archive_form_components":
            ids = [int(item) for item in config.get("component_ids") or []]
            return (f"SELECT {DECODED} AS v FROM archive_form f JOIN archive_form_field ff ON ff.archive_form_id=f.id "
                    f"WHERE f.archive_case_id=a.id AND ff.source_component_id=ANY({self.bind(ids)}) AND nullif(btrim({DECODED}),'') IS NOT NULL")
        if resolver == "form_presence":
            names = [str(item).lower() for item in config.get("form_names") or []]
            return f"SELECT f.name AS v FROM archive_form f WHERE f.archive_case_id=a.id AND lower(f.name)=ANY({self.bind(names)})"
        raise _bad(f"{row['label']} has an unsupported source")

    def is_multi(self, row: dict[str, Any]) -> bool:
        return row.get("cardinality") == "multi"

    def result(self, row: dict[str, Any]) -> str:
        if self.is_multi(row):
            return f"(SELECT string_agg(DISTINCT btrim(x.v), ', ') FROM ({self.values(row)}) x)"
        return self.scalar(row)

    def matches(self, row: dict[str, Any], value: Any) -> list[str]:
        """Lower-cased texts a filter value stands for: an option code expands to its label and aliases."""
        items = value if isinstance(value, list) else [value]
        texts: list[str] = []
        by_code = {option["value"]: option for option in self.options.get(row["id"], [])}
        for item in items:
            if item is None or str(item).strip() == "":
                continue
            option = by_code.get(str(item))
            if option:
                texts += [str(option["label"]), *[str(alias) for alias in option.get("aliases") or []]]
            texts.append(str(item))
        out = list(dict.fromkeys(text.strip().lower() for text in texts if text.strip()))
        if not out:
            raise _bad(f"Choose a value for {row['label']}")
        return out

    # Filters ------------------------------------------------------------------------------
    def condition(self, spec: dict[str, Any]) -> str:
        row = self.field(spec.get("field"), "filter")
        op = str(spec.get("op") or "")
        if op not in (row.get("operators") or []):
            raise _bad(f"{row['label']} does not support '{op}'")
        value = spec.get("value")
        if self.is_multi(row):
            values = self.values(row)
            if op == "is_empty":
                return f"NOT EXISTS ({values})"
            if op == "is_not_empty":
                return f"EXISTS ({values})"
            if op in {"contains", "starts_with"}:
                text = _like(str(value or "").strip())
                if not text:
                    raise _bad(f"Enter text for {row['label']}")
                pattern = f"%{text}%" if op == "contains" else f"{text}%"
                return f"EXISTS (SELECT 1 FROM ({values}) x WHERE x.v ILIKE {self.bind(pattern)})"
            texts = self.matches(row, value)
            if op == "contains_all":
                raw = value if isinstance(value, list) else [value]
                return " AND ".join(f"EXISTS (SELECT 1 FROM ({self.values(row)}) x WHERE lower(btrim(x.v))=ANY({self.bind(self.matches(row, item))}))" for item in raw if str(item or "").strip()) or "TRUE"
            return f"EXISTS (SELECT 1 FROM ({values}) x WHERE lower(btrim(x.v))=ANY({self.bind(texts)}))"

        expression = self.scalar(row)
        kind = row.get("data_type")
        if op == "is_empty":
            return f"nullif(btrim({expression}::text),'') IS NULL"
        if op == "is_not_empty":
            return f"nullif(btrim({expression}::text),'') IS NOT NULL"
        if kind in {"date", "datetime"}:
            def day(item: Any) -> str:
                text = str(item or "").strip()[:10]
                if len(text) != 10:
                    raise _bad(f"Choose a date for {row['label']}")
                return self.bind(text)
            if op == "between":
                pair = value if isinstance(value, list) and len(value) == 2 else [None, None]
                return f"{expression} >= {day(pair[0])}::date AND {expression} < ({day(pair[1])}::date + 1)"
            if op == "before":
                return f"{expression} < ({day(value)}::date + 1)"
            if op == "after":
                return f"{expression} >= {day(value)}::date"
            if op == "equals":
                placeholder = day(value)
                return f"{expression} >= {placeholder}::date AND {expression} < ({placeholder}::date + 1)"
        if kind in {"number", "duration"}:
            def number(item: Any) -> str:
                try:
                    return f"{self.bind(float(item))}::numeric"
                except (TypeError, ValueError):
                    raise _bad(f"Enter a number for {row['label']}") from None
            if op == "between":
                pair = value if isinstance(value, list) and len(value) == 2 else [None, None]
                return f"{expression} BETWEEN {number(pair[0])} AND {number(pair[1])}"
            if op in {"greater_than", "less_than", "equals"}:
                sign = {"greater_than": ">", "less_than": "<", "equals": "="}[op]
                return f"{expression} {sign} {number(value)}"
        if kind == "boolean" and op == "equals":
            return f"{expression} = {self.bind(bool(value))}"
        if op in {"contains", "starts_with"}:
            text = _like(str(value or "").strip())
            if not text:
                raise _bad(f"Enter text for {row['label']}")
            return f"{expression}::text ILIKE {self.bind(f'%{text}%' if op == 'contains' else f'{text}%')}"
        if op in {"equals", "in", "contains_any"}:
            return f"lower(btrim({expression}::text))=ANY({self.bind(self.matches(row, value))})"
        raise _bad(f"{row['label']} does not support '{op}'")


def compile_spec(spec: Any, fields: list[dict[str, Any]], options: dict[str, list[dict[str, Any]]], base_where: str, base_params: dict[str, Any]) -> Compiled:
    """base_where filters archive_case a / archive_case_context c (source system, period, HN, staff)."""
    if not isinstance(spec, dict):
        raise _bad("Report definition must be an object")
    builder = _Builder({row["id"]: row for row in fields}, options, dict(base_params))
    view = spec.get("view")
    if view not in {"list", "stats"}:
        raise _bad("Choose a list or statistics report")
    filters = spec.get("filters") or []
    if not isinstance(filters, list) or len(filters) > MAX_FILTERS:
        raise _bad(f"Use at most {MAX_FILTERS} filters")
    where = [base_where, *[builder.condition(item) for item in filters if isinstance(item, dict)]]
    filtered = ("filtered AS (SELECT a.id FROM archive_case a LEFT JOIN archive_case_context c ON c.archive_case_id=a.id "
                f"WHERE {' AND '.join(f'({clause})' for clause in where)})")
    source = "FROM filtered fz JOIN archive_case a ON a.id=fz.id LEFT JOIN archive_case_context c ON c.archive_case_id=a.id"
    columns: list[dict[str, Any]] = []

    if view == "list":
        items = [item for item in spec.get("columns") or [] if isinstance(item, dict)]
        if not items:
            raise _bad("Drag at least one field into Columns")
        if len(items) > MAX_COLUMNS:
            raise _bad(f"Use at most {MAX_COLUMNS} columns")
        select = ["a.id::text AS record_id"]
        for index, item in enumerate(items):
            row = builder.field(item.get("field"), "result")
            key = f"c{index}"
            select.append(f"{builder.result(row)} AS {key}")
            columns.append({"key": key, "label": builder.label(str(item.get("label") or row["label"])), "kind": "column",
                            "field": row["id"], "data_type": "text" if builder.is_multi(row) else row["data_type"]})
        sql = f"WITH {filtered} SELECT {', '.join(select)} {source}"
        order_by = _order(spec, columns, default=f"{columns[0]['key']} NULLS LAST,record_id")
        return Compiled(sql, builder.params, columns, order_by, view, None, filtered)

    groups = [item for item in spec.get("groups") or [] if isinstance(item, dict)]
    measures = [item for item in spec.get("measures") or [] if isinstance(item, dict)] or [{"agg": "count_cases"}]
    if len(groups) > MAX_GROUPS:
        raise _bad(f"Group by at most {MAX_GROUPS} fields")
    if len(measures) > MAX_MEASURES:
        raise _bad(f"Use at most {MAX_MEASURES} statistics")
    select, joins, group_keys = [], [], []
    for index, item in enumerate(groups):
        row = builder.field(item.get("field"), "group")
        key = f"g{index}"
        if builder.is_multi(row):
            joins.append(f"LEFT JOIN LATERAL (SELECT DISTINCT btrim(x.v) AS v FROM ({builder.values(row)}) x) j{index} ON TRUE")
            expression = f"coalesce(j{index}.v,'Missing')"
        elif row["data_type"] in {"date", "datetime"}:
            unit, pattern = BUCKETS.get(str(item.get("bucket") or "month"), BUCKETS["month"])
            expression = f"coalesce(to_char(date_trunc('{unit}',{builder.scalar(row)}),'{pattern}'),'Missing')"
        elif row["data_type"] in {"number", "duration"}:
            expression = builder.scalar(row)
        else:
            expression = f"coalesce(nullif(btrim({builder.scalar(row)}::text),''),'Missing')"
        select.append(f"{expression} AS {key}")
        group_keys.append(key)
        bucket = f" ({item.get('bucket') or 'month'})" if row["data_type"] in {"date", "datetime"} else ""
        columns.append({"key": key, "label": builder.label(str(item.get("label") or f"{row['label']}{bucket}")), "kind": "group",
                        "field": row["id"], "data_type": "number" if row["data_type"] in {"number", "duration"} else "text"})
    for index, item in enumerate(measures):
        agg = str(item.get("agg") or "")
        key = f"m{index}"
        row = None
        if agg == "count_cases":
            expression = "count(DISTINCT a.id)"
        elif agg == "count_patients":
            expression = "count(DISTINCT coalesce(nullif(c.hn,''),a.id::text))"
        elif agg == "pct_cases":
            expression = "round(100.0*count(DISTINCT a.id)/nullif((SELECT count(*) FROM filtered),0),1)"
        elif agg == "count_filled":
            row = builder.field(item.get("field"), "result")
            present = f"EXISTS ({builder.values(row)})" if builder.is_multi(row) else f"nullif(btrim({builder.scalar(row)}::text),'') IS NOT NULL"
            expression = f"count(DISTINCT a.id) FILTER (WHERE {present})"
        elif agg in NUMERIC_AGGS:
            row = builder.field(item.get("field"), "measure")
            if builder.is_multi(row) or row["data_type"] not in {"number", "duration"}:
                raise _bad(f"{AGG_LABELS[agg]} needs a number field")
            value = f"({builder.scalar(row)})::numeric"
            expression = {
                "avg": f"round(avg({value}),1)", "min": f"min({value})", "max": f"max({value})", "sum": f"sum({value})",
                "median": f"round((percentile_cont(0.5) WITHIN GROUP (ORDER BY {value}))::numeric,1)",
                "p90": f"round((percentile_cont(0.9) WITHIN GROUP (ORDER BY {value}))::numeric,1)",
                "stddev": f"round(stddev_samp({value}),1)",
            }[agg]
        else:
            raise _bad(f"Unknown statistic: {agg}")
        select.append(f"{expression} AS {key}")
        default = AGG_LABELS[agg] + (f" {row['label'].lower()}" if agg == "count_filled" and row else f" · {row['label']}" if row else "")
        columns.append({"key": key, "label": builder.label(str(item.get("label") or default)), "kind": "measure",
                        "agg": agg, "field": row["id"] if row else None, "data_type": "number"})
    group_by = f" GROUP BY {', '.join(str(n) for n in range(1, len(group_keys) + 1))}" if group_keys else ""
    sql = f"WITH {filtered} SELECT {', '.join(select)} {source} {' '.join(joins)}{group_by}"
    default = ",".join(f"{key} NULLS LAST" for key in group_keys) or columns[-1]["key"]
    limit = spec.get("limit")
    try:
        limit = max(1, min(1000, int(limit))) if limit not in (None, "", 0) else None
    except (TypeError, ValueError):
        raise _bad("Top N must be a number") from None
    return Compiled(sql, builder.params, columns, _order(spec, columns, default), view, limit, filtered)


def _order(spec: dict[str, Any], columns: list[dict[str, Any]], default: str) -> str:
    sort = spec.get("sort") if isinstance(spec.get("sort"), dict) else None
    keys = {column["key"] for column in columns}
    if sort and sort.get("key") in keys:
        direction = "DESC" if sort.get("dir") == "desc" else "ASC"
        return f"{sort['key']} {direction} NULLS LAST,{default}"
    return default
