import csv
import io
import math
import zipfile
from datetime import date, datetime
from html import escape
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from psycopg import Connection

from ..database import connection
from ..demo_ward import DEMO_SOURCE
from .auth_canopy import read_token

router = APIRouter(prefix="/api/reports", tags=["canopy-reports"], dependencies=[Depends(read_token)])

FORM_COMPONENTS = {
    "anes-technique": (4490, 4897, 4896, 2657, 790),
    "anes-ra": (898, 899, 900),
    "general-item-equipment": (2699,),
    "special-technique": (1406,),
    "nerve-block": (4816, 4091, 4092, 900, 4093),
}


def _report(database: Connection, report_id: str) -> dict[str, Any]:
    row = database.execute(
        """SELECT id,title,description,category,source_system,definition,is_system,is_active,
                  sort_order,created_by,created_at,updated_at
           FROM canopy_report_definition WHERE id=%s AND is_active""", (report_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Report definition not found")
    definition = row.get("definition") or {}
    if definition.get("dataset") != "innovian_archive" or definition.get("engine_report") != report_id:
        raise HTTPException(status_code=422, detail="Unsupported Canopy report definition")
    return row


def _integer(query: dict[str, str], name: str, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(query.get(name, default))))
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"Invalid {name}") from error


def _source_system(request: Request, database: Connection) -> str:
    """Archive source for the selected ward: the demo ward reports on its synthetic
    'flora-demo' cases only; every other selection reports on the Innovian archive."""
    ward = request.headers.get("x-flora-ward", "").strip()
    if ward and ward.lower() != "all" and database.execute(
        "SELECT 1 FROM canopy_location WHERE id::text=%s AND kind='care_unit' AND is_demo", (ward,)
    ).fetchone():
        return DEMO_SOURCE
    return "innovian"


def _query(request: Request, database: Connection) -> dict[str, str]:
    query = dict(request.query_params)
    query.pop("format", None)
    query["_source"] = _source_system(request, database)
    return query


def _filters(query: dict[str, str]) -> tuple[str, dict[str, Any]]:
    clauses = ["a.source_system=%(source_system)s"]
    params: dict[str, Any] = {"source_system": query.get("_source") or "innovian"}
    if query.get("from"):
        clauses.append("a.started_at >= %(from_date)s::date")
        params["from_date"] = query["from"]
    if query.get("to"):
        clauses.append("a.started_at < (%(to_date)s::date + interval '1 day')")
        params["to_date"] = query["to"]
    if query.get("hn"):
        clauses.append("c.hn ILIKE %(hn)s")
        params["hn"] = f"%{query['hn'].strip()}%"
    if query.get("staff") or query.get("role"):
        assignment = ["sf.archive_case_id=a.id", "NOT sf.source_deleted"]
        if query.get("staff"):
            assignment.append("sf.display_name ILIKE %(staff)s")
            params["staff"] = f"%{query['staff'].strip()}%"
        if query.get("role"):
            assignment.append("lower(btrim(coalesce(sf.role,'')))=lower(btrim(%(role_exact)s))")
            params["role_exact"] = query["role"].strip()
        clauses.append(f"EXISTS (SELECT 1 FROM archive_staff_assignment sf WHERE {' AND '.join(assignment)})")
    return " AND ".join(clauses), params


def _cases_cte(query: dict[str, str]) -> tuple[str, dict[str, Any]]:
    where, params = _filters(query)
    return f"""cases AS (
      SELECT a.id record_id,a.source_case_id,a.started_at,a.completed_at,c.hn,c.encounter_number,
             c.patient_name,c.asa_status,c.case_type,c.care_unit,c.location,c.procedure_name
      FROM archive_case a LEFT JOIN archive_case_context c ON c.archive_case_id=a.id WHERE {where}
    )""", params


def _completion_clause(query: dict[str, str], expression: str) -> str:
    if query.get("completeness") == "complete":
        return f" WHERE {expression}='complete'"
    if query.get("completeness") == "incomplete":
        return f" WHERE {expression}<>'complete'"
    return ""


def _paged(database: Connection, sql: str, params: dict[str, Any], query: dict[str, str], order_by: str):
    page = _integer(query, "page", 1, 1, 1_000_000)
    size = _integer(query, "page_size", 50, 1, 500)
    total = database.execute(f"SELECT count(*) n FROM ({sql}) report_rows", params).fetchone()["n"]
    rows = database.execute(
        f"SELECT * FROM ({sql}) report_rows ORDER BY {order_by} LIMIT %(limit)s OFFSET %(offset)s",
        {**params, "limit": size, "offset": (page - 1) * size},
    ).fetchall()
    return rows, {"page": page, "page_size": size, "total": total, "total_pages": max(1, math.ceil(total / size))}


def _detail_summary(database: Connection, sql: str, params: dict[str, Any], status: str):
    return database.execute(
        f"SELECT count(*) records,count(*) FILTER(WHERE {status}='complete') complete,count(*) FILTER(WHERE {status}<>'complete') incomplete FROM ({sql}) s",
        params,
    ).fetchone()


def _detail_result(database: Connection, report_id: str, sql: str, params: dict[str, Any], query: dict[str, str], status: str, order: str):
    rows, pagination = _paged(database, sql, params, query, order)
    return {"report": report_id, "mode": "detail", "summary": _detail_summary(database, sql, params, status), "rows": rows, "pagination": pagination}


def _admit_discharge(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    sql = f"""WITH {cases},events AS (
      SELECT e.archive_case_id,
        min(e.occurred_at) FILTER(WHERE lower(e.source_event_name)='in/out or' AND e.source_state='1') patient_in,
        max(e.occurred_at) FILTER(WHERE lower(e.source_event_name)='in/out or' AND e.source_state='2') patient_out
      FROM archive_event e JOIN cases c ON c.record_id=e.archive_case_id GROUP BY e.archive_case_id
    ),prepared AS (
      SELECT c.record_id,c.hn,c.patient_name,e.patient_in admit_datetime,e.patient_out discharge_datetime,
        round(extract(epoch FROM(e.patient_out-e.patient_in))/60)::integer stay_minutes,
        c.care_unit care_unit_label,c.location device_label,c.asa_status,
        CASE WHEN e.patient_in IS NOT NULL AND e.patient_out IS NOT NULL THEN 'complete' ELSE 'incomplete' END record_status
      FROM cases c LEFT JOIN events e ON e.archive_case_id=c.record_id
    ) SELECT * FROM prepared{_completion_clause(query, 'record_status')}"""
    return _detail_result(database, "admit-discharge-time", sql, params, query, "record_status", "admit_datetime NULLS LAST,record_id")


def _staff_time(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    assignment_filter = ""
    if query.get("role"):
        assignment_filter += " AND lower(btrim(coalesce(s.role,'')))=lower(btrim(%(staff_row_role)s))"
        params["staff_row_role"] = query["role"].strip()
    if query.get("staff"):
        assignment_filter += " AND s.display_name ILIKE %(staff)s"
    sql = f"""WITH {cases},patient_in AS (
      SELECT e.archive_case_id,min(e.occurred_at) occurred_at FROM archive_event e JOIN cases c ON c.record_id=e.archive_case_id
      WHERE lower(e.source_event_name)='in/out or' AND e.source_state='1' GROUP BY e.archive_case_id
    ),prepared AS (
      SELECT s.id record_id,c.hn,c.patient_name,s.display_name staff_name,s.role staff_role,s.entered_at staff_time_in,
        p.occurred_at patient_in_or_datetime,round(extract(epoch FROM(s.entered_at-p.occurred_at))/60)::integer duration_minutes,
        CASE WHEN s.entered_at IS NOT NULL AND p.occurred_at IS NOT NULL THEN 'complete' ELSE 'incomplete' END record_status
      FROM cases c JOIN archive_staff_assignment s ON s.archive_case_id=c.record_id AND NOT s.source_deleted{assignment_filter}
      LEFT JOIN patient_in p ON p.archive_case_id=c.record_id
    ) SELECT * FROM prepared{_completion_clause(query, 'record_status')}"""
    return _detail_result(database, "staff-time-in-or", sql, params, query, "record_status", "staff_time_in NULLS LAST,record_id")


def _release_time(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    sql = f"""WITH {cases},events AS (
      SELECT e.archive_case_id,
        min(e.occurred_at) FILTER(WHERE lower(e.source_event_name)='anesthesia' AND e.source_state='1') start_anes,
        min(e.occurred_at) FILTER(WHERE lower(e.source_event_name)='positioning' AND e.source_state='1') position_1
      FROM archive_event e JOIN cases c ON c.record_id=e.archive_case_id GROUP BY e.archive_case_id
    ),prepared AS (
      SELECT c.record_id,c.hn,c.patient_name,e.start_anes start_anes_datetime,e.position_1 position_1_datetime,
        round(extract(epoch FROM(e.position_1-e.start_anes))/60)::integer duration_minutes,
        CASE WHEN e.start_anes IS NULL OR e.position_1 IS NULL THEN 'incomplete' WHEN e.position_1<e.start_anes THEN 'implausible' ELSE 'complete' END release_record_status
      FROM cases c LEFT JOIN events e ON e.archive_case_id=c.record_id
    ) SELECT * FROM prepared{_completion_clause(query, 'release_record_status')}"""
    return _detail_result(database, "anaesthetic-release-time", sql, params, query, "release_record_status", "start_anes_datetime NULLS LAST,record_id")


def _monthly_result(database: Connection, report_id: str, source: str, params: dict[str, Any], query: dict[str, str]):
    status = ""
    if query.get("completeness") == "complete":
        status = " WHERE category<>'Missing'"
    elif query.get("completeness") == "incomplete":
        status = " WHERE category='Missing'"
    filtered = f"SELECT * FROM ({source}) category_source{status}"
    if query.get("mode") == "detail":
        conditions = []
        if query.get("month"):
            conditions.append("to_char(date_trunc('month',started_at),'YYYY-MM')=%(month)s")
            params["month"] = query["month"]
        if query.get("category"):
            conditions.append("category=%(category)s")
            params["category"] = query["category"]
        detail = f"SELECT * FROM ({filtered}) f"
        if conditions:
            detail += " WHERE " + " AND ".join(conditions)
        rows, pagination = _paged(database, detail, params, query, "started_at,record_id")
        return {"report": report_id, "mode": "detail", "rows": rows, "pagination": pagination}
    rows = database.execute(
        f"SELECT to_char(date_trunc('month',started_at),'YYYY-MM') AS month,category,count(DISTINCT record_id) AS case_count,count(DISTINCT coalesce(nullif(hn,''),record_id::text)) AS patient_count FROM ({filtered}) f GROUP BY 1,2 ORDER BY 1,2",
        params,
    ).fetchall()
    summary = database.execute(f"SELECT count(DISTINCT record_id) cases,count(DISTINCT category) categories FROM ({filtered}) f", params).fetchone()
    return {"report": report_id, "mode": "summary", "summary": summary, "rows": rows}


def _context_monthly(database: Connection, report_id: str, field: str, query: dict[str, str]):
    cases, params = _cases_cte(query)
    source = f"WITH {cases} SELECT record_id,hn,patient_name,started_at,procedure_name,coalesce(nullif(btrim({field}),''),'Missing') category FROM cases"
    return _monthly_result(database, report_id, source, params, query)


def _form_monthly(database: Connection, report_id: str, query: dict[str, str]):
    cases, params = _cases_cte(query)
    params["components"] = list(FORM_COMPONENTS[report_id])
    value = "coalesce(nullif(ff.value#>>'{selected,0,label}',''),nullif(ff.value->>'text',''),nullif(ff.value->>'value',''),nullif(ff.raw_value,''))"
    source = f"""WITH {cases},values AS (
      SELECT DISTINCT f.archive_case_id,{value} category FROM archive_form f JOIN archive_form_field ff ON ff.archive_form_id=f.id
      JOIN cases c ON c.record_id=f.archive_case_id WHERE ff.source_component_id=ANY(%(components)s) AND {value} IS NOT NULL
    ) SELECT c.record_id,c.hn,c.patient_name,c.started_at,c.procedure_name,coalesce(nullif(btrim(v.category),''),'Missing') category
      FROM cases c JOIN values v ON v.archive_case_id=c.record_id"""
    return _monthly_result(database, report_id, source, params, query)


def _ga(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    decoded = "coalesce(nullif(ff.value#>>'{selected,0,label}',''),nullif(ff.value->>'text',''),nullif(ff.value->>'value',''),nullif(ff.raw_value,''))"
    source = f"""WITH {cases},ga_cases AS (
      SELECT DISTINCT f.archive_case_id FROM archive_form f
      JOIN archive_form_field ff ON ff.archive_form_id=f.id
      JOIN cases c ON c.record_id=f.archive_case_id
      WHERE ff.source_component_id=790 AND {decoded} IS NOT NULL
        AND btrim({decoded})<>'' AND lower(btrim({decoded})) NOT IN ('0','false','no','-')
    ) SELECT c.record_id,c.hn,c.patient_name,c.started_at,c.procedure_name,
             'General anesthesia'::text AS category
      FROM cases c JOIN ga_cases g ON g.archive_case_id=c.record_id"""
    return _monthly_result(database, "anes-ga", source, params, query)


def _intubation(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    decoded = "coalesce(nullif(ff.value#>>'{selected,0,label}',''),nullif(ff.value->>'text',''),nullif(ff.value->>'value',''),nullif(ff.raw_value,''))"
    source = f"""WITH {cases},meaningful AS (
      SELECT f.archive_case_id,ff.source_component_id,btrim({decoded}) value
      FROM archive_form f JOIN archive_form_field ff ON ff.archive_form_id=f.id
      JOIN cases c ON c.record_id=f.archive_case_id
      WHERE ff.source_component_id IN (5060,5055,4491,868,4487,4489,873,871)
        AND {decoded} IS NOT NULL AND btrim({decoded})<>''
        AND lower(btrim({decoded})) NOT IN ('0','false','no','-')
    ),form_summary AS (
      SELECT archive_case_id,
        max(value) FILTER(WHERE source_component_id=5060) airway_equipment,
        max(value) FILTER(WHERE source_component_id=4487) intubating_technique,
        max(value) FILTER(WHERE source_component_id=4489) laryngoscope,
        max(value) FILTER(WHERE source_component_id=4491) blade_size,
        max(value) FILTER(WHERE source_component_id=868) cuffed,
        max(value) FILTER(WHERE source_component_id=871) tube_size,
        max(value) FILTER(WHERE source_component_id=873) tube_depth,
        max(value) FILTER(WHERE source_component_id=5055) airway_problem
      FROM meaningful GROUP BY archive_case_id
    ) SELECT c.record_id,c.hn,c.patient_name,c.started_at,c.procedure_name,
      CASE WHEN lower(coalesce(fs.laryngoscope,'')) LIKE '%%video%%' THEN 'Video laryngoscopy'
           WHEN lower(coalesce(fs.intubating_technique,'')) LIKE '%%direct%%'
             OR lower(coalesce(fs.laryngoscope,'')) IN ('macintoch','miller') THEN 'Direct laryngoscopy'
           WHEN lower(coalesce(fs.intubating_technique,''))='inubating lma' THEN 'Intubating LMA'
           ELSE coalesce(fs.intubating_technique,fs.laryngoscope,'Other / unspecified') END category,
      fs.airway_equipment,fs.intubating_technique,fs.laryngoscope,fs.blade_size,
      fs.cuffed,fs.tube_size,fs.tube_depth,fs.airway_problem
      FROM cases c JOIN form_summary fs ON fs.archive_case_id=c.record_id
      WHERE fs.intubating_technique IS NOT NULL OR fs.laryngoscope IS NOT NULL"""
    return _monthly_result(database, "intubation-technique", source, params, query)


def _pacu(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    source = f"""WITH {cases},values AS (
      SELECT DISTINCT f.archive_case_id,CASE WHEN lower(f.name)='pacu (ambulatory)' THEN 'PACU Ambulatory' ELSE 'PACU' END category
      FROM archive_form f JOIN cases c ON c.record_id=f.archive_case_id WHERE lower(f.name) IN('pacu','pacu (ambulatory)')
    ) SELECT c.record_id,c.hn,c.patient_name,c.started_at,c.procedure_name,coalesce(v.category,'Missing') category
      FROM cases c JOIN values v ON v.archive_case_id=c.record_id"""
    return _monthly_result(database, "pacu-summary", source, params, query)


def _case_volume(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    where = "WHERE completed_at IS NOT NULL" if query.get("completeness") == "complete" else "WHERE completed_at IS NULL" if query.get("completeness") == "incomplete" else ""
    rows = database.execute(f"""WITH {cases} SELECT to_char(date_trunc('month',started_at),'YYYY-MM') AS month,count(*) AS encounter_count,
      count(DISTINCT coalesce(nullif(hn,''),record_id::text)) AS patient_count,count(*) FILTER(WHERE completed_at IS NOT NULL) AS complete_count,
      count(*) FILTER(WHERE completed_at IS NULL) AS missing_count,round(avg(extract(epoch FROM(completed_at-started_at))/60))::integer AS average_stay_minutes
      FROM cases {where} GROUP BY 1 ORDER BY 1""", params).fetchall()
    summary = database.execute(f"WITH {cases} SELECT count(*) encounters,count(DISTINCT coalesce(nullif(hn,''),record_id::text)) patients,count(*) FILTER(WHERE completed_at IS NULL) incomplete FROM cases {where}", params).fetchone()
    return {"report": "case-volume-month", "mode": "summary", "summary": summary, "rows": rows}


def _pdf_completeness(database: Connection, query: dict[str, str]):
    cases, params = _cases_cte(query)
    sql = f"""WITH {cases},prepared AS (
      SELECT c.record_id,c.hn,c.patient_name,c.started_at admit_datetime,
        bool_or(r.report_type='ANES' AND r.expected AND r.file_path IS NOT NULL) found_anes,
        bool_or(r.report_type='FORM' AND r.expected AND r.file_path IS NOT NULL) found_form,
        bool_or(r.report_type='POST' AND r.expected AND r.file_path IS NOT NULL) found_post,
        bool_or(r.report_type='PACU' AND r.expected AND r.file_path IS NOT NULL) found_pacu,
        coalesce(string_agg(r.report_type,', ' ORDER BY r.report_type) FILTER(WHERE r.expected AND r.file_path IS NULL),'') missing_types,
        count(*) FILTER(WHERE r.expected AND r.file_path IS NOT NULL) source_count,
        CASE WHEN count(*) FILTER(WHERE r.expected)=0 THEN 'not_classified' WHEN count(*) FILTER(WHERE r.expected AND r.file_path IS NULL)=0 THEN 'complete' ELSE 'incomplete' END record_status
      FROM cases c LEFT JOIN archive_case_report r ON r.archive_case_id=c.record_id GROUP BY c.record_id,c.hn,c.patient_name,c.started_at
    ) SELECT * FROM prepared{_completion_clause(query, 'record_status')}"""
    return _detail_result(database, "pdf-report-completeness", sql, params, query, "record_status", "admit_datetime NULLS LAST,record_id")


ReportRunner = Callable[[Connection, dict[str, str]], dict[str, Any]]


def _runner(report_id: str) -> ReportRunner:
    runners: dict[str, ReportRunner] = {
        "admit-discharge-time": _admit_discharge, "staff-time-in-or": _staff_time,
        "anaesthetic-release-time": _release_time,
        "asa-status": lambda db, q: _context_monthly(db, "asa-status", "asa_status", q),
        "case-type-service": lambda db, q: _context_monthly(db, "case-type-service", "case_type", q),
        "anes-ga": _ga, "intubation-technique": _intubation,
        "pacu-summary": _pacu, "case-volume-month": _case_volume,
        "pdf-report-completeness": _pdf_completeness,
    }
    for item in FORM_COMPONENTS:
        runners[item] = lambda db, q, selected=item: _form_monthly(db, selected, q)
    if report_id not in runners:
        raise HTTPException(status_code=422, detail="Unsupported Canopy report")
    return runners[report_id]


def _execute(database: Connection, report_id: str, query: dict[str, str]):
    _report(database, report_id)
    try:
        return _runner(report_id)(database, query)
    except HTTPException:
        raise
    except Exception as error:
        if getattr(error, "sqlstate", "") == "42P01":
            raise HTTPException(status_code=503, detail="Canopy archive schema is not installed") from error
        raise


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return str(value)


def _csv(rows: list[dict[str, Any]]) -> bytes:
    output = io.StringIO(newline="")
    columns = list(rows[0]) if rows else []
    writer = csv.DictWriter(output, fieldnames=columns)
    writer.writeheader()
    writer.writerows({key: _cell(value) for key, value in row.items()} for row in rows)
    return output.getvalue().encode("utf-8-sig")


def _xlsx(rows: list[dict[str, Any]]) -> bytes:
    columns = list(rows[0]) if rows else []
    table = [columns, *[[_cell(row.get(column)) for column in columns] for row in rows]]
    xml_rows = []
    for row_number, row in enumerate(table, 1):
        cells = []
        for column_number, value in enumerate(row, 1):
            letters, n = "", column_number
            while n:
                n, remainder = divmod(n - 1, 26)
                letters = chr(65 + remainder) + letters
            cells.append(f'<c r="{letters}{row_number}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        xml_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
    sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + "".join(xml_rows) + '</sheetData></worksheet>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as book:
        book.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        book.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        book.writestr("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>')
        book.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        book.writestr("xl/worksheets/sheet1.xml", sheet)
    return output.getvalue()


@router.get("")
def report_library(database: Connection = Depends(connection)):
    rows = database.execute("SELECT id,title,description,category,source_system,definition,is_system,is_active,sort_order,created_by,created_at,updated_at FROM canopy_report_definition WHERE is_active ORDER BY sort_order,title").fetchall()
    return {"rows": rows, "total": len(rows)}


@router.get("/filter-options/staff")
def report_staff_options(
    request: Request,
    q: str = Query(default="", max_length=120),
    role: str = Query(default="", max_length=160),
    limit: int = Query(default=30, ge=1, le=100),
    database: Connection = Depends(connection),
):
    needle = f"%{q.strip()}%"
    source = _source_system(request, database)
    staff = database.execute(
        """WITH candidates AS (
             SELECT staff_name AS name,coalesce(nullif(staff_role,''),r.display_name) AS role,
                    greatest(coalesce(used_count,0),1) AS uses,true AS in_master
             FROM staff_directory d LEFT JOIN staff_role r ON r.id=d.staff_role_id
             WHERE d.is_active=1 AND d.staff_name IS NOT NULL
             UNION ALL
             SELECT display_name AS name,role,count(*) AS uses,false AS in_master
             FROM archive_staff_assignment s JOIN archive_case a ON a.id=s.archive_case_id
             WHERE NOT source_deleted AND display_name IS NOT NULL AND a.source_system=%s
             GROUP BY display_name,role
           )
           SELECT name,role,bool_or(in_master) AS in_master,sum(uses) AS usage_count
           FROM candidates
           WHERE (%s='' OR name ILIKE %s OR coalesce(role,'') ILIKE %s)
             AND (%s='' OR lower(btrim(coalesce(role,'')))=lower(btrim(%s)))
           GROUP BY name,role
           ORDER BY bool_or(in_master) DESC,sum(uses) DESC,name
           LIMIT %s""",
        (source, q.strip(), needle, needle, role.strip(), role.strip(), limit),
    ).fetchall()
    roles = database.execute(
        """SELECT role FROM (
             SELECT nullif(btrim(display_name),'') AS role FROM staff_role
             UNION SELECT nullif(btrim(staff_role),'') FROM staff_directory WHERE is_active=1
             UNION SELECT nullif(btrim(role),'') FROM archive_staff_assignment s
               JOIN archive_case a ON a.id=s.archive_case_id WHERE NOT source_deleted AND a.source_system=%s
           ) roles WHERE role IS NOT NULL ORDER BY role""", (source,)
    ).fetchall()
    return {"staff": staff, "roles": [row["role"] for row in roles]}


@router.get("/metadata")
def report_metadata(database: Connection = Depends(connection)):
    datasets = database.execute(
        """SELECT id,title,description,grain,source_system,sort_order
           FROM canopy_report_dataset WHERE is_active ORDER BY sort_order,title"""
    ).fetchall()
    fields = database.execute(
        """SELECT id,dataset_id,label,description,section,data_type,cardinality,
                  allowed_uses,operators,source_config,sort_order
           FROM canopy_report_field WHERE is_active
           ORDER BY dataset_id,section,sort_order,label"""
    ).fetchall()
    return {"datasets": datasets, "fields": fields}


@router.get("/metadata/fields/{field_id}/values")
def report_field_values(
    field_id: str,
    request: Request,
    q: str = Query(default="", max_length=120),
    limit: int = Query(default=50, ge=1, le=200),
    database: Connection = Depends(connection),
):
    field = database.execute(
        "SELECT id,source_config FROM canopy_report_field WHERE id=%s AND is_active", (field_id,)
    ).fetchone()
    if not field:
        raise HTTPException(status_code=404, detail="Report field not found")
    needle = f"%{q.strip()}%"
    options = database.execute(
        """SELECT value_code AS value,display_label AS label
           FROM canopy_report_field_option
           WHERE field_id=%s AND is_active AND (%s='' OR display_label ILIKE %s OR aliases::text ILIKE %s)
           ORDER BY sort_order,display_label LIMIT %s""",
        (field_id, q.strip(), needle, needle, limit),
    ).fetchall()
    if options:
        return {"field_id": field_id, "rows": options}
    config = field["source_config"] or {}
    resolver = config.get("resolver")
    source = _source_system(request, database)
    in_source = "archive_case_id IN (SELECT id FROM archive_case WHERE source_system=%s)"
    if resolver == "context_column":
        columns = {"hn", "patient_name", "asa_status", "case_type", "procedure_name", "location"}
        column = str(config.get("column") or "")
        if column not in columns:
            raise HTTPException(status_code=422, detail="Unsupported report field resolver")
        rows = database.execute(
            f"SELECT DISTINCT {column} AS value,{column} AS label FROM archive_case_context "
            f"WHERE {in_source} AND {column} IS NOT NULL AND btrim({column})<>'' AND (%s='' OR {column} ILIKE %s) "
            f"ORDER BY {column} LIMIT %s",
            (source, q.strip(), needle, limit),
        ).fetchall()
    elif resolver == "staff_assignment":
        column = config.get("column")
        if column not in {"display_name", "role"}:
            raise HTTPException(status_code=422, detail="Unsupported report field resolver")
        rows = database.execute(
            f"SELECT DISTINCT {column} AS value,{column} AS label FROM archive_staff_assignment "
            f"WHERE {in_source} AND NOT source_deleted AND {column} IS NOT NULL AND btrim({column})<>'' "
            f"AND (%s='' OR {column} ILIKE %s) ORDER BY {column} LIMIT %s",
            (source, q.strip(), needle, limit),
        ).fetchall()
    elif resolver == "archive_form_components":
        component_ids = config.get("component_ids") or []
        decoded = "coalesce(nullif(value#>>'{selected,0,label}',''),nullif(value->>'text',''),nullif(value->>'value',''),nullif(raw_value,''))"
        rows = database.execute(
            f"""SELECT DISTINCT decoded AS value,decoded AS label FROM (
                   SELECT {decoded} AS decoded FROM archive_form_field
                   WHERE source_component_id=ANY(%s)
                     AND archive_form_id IN (SELECT id FROM archive_form WHERE {in_source})
                 ) values WHERE decoded IS NOT NULL AND btrim(decoded)<>''
                   AND (%s='' OR decoded ILIKE %s) ORDER BY decoded LIMIT %s""",
            (component_ids, source, q.strip(), needle, limit),
        ).fetchall()
    elif resolver == "form_presence":
        names = config.get("form_names") or []
        rows = [{"value": name, "label": name} for name in names if not q or q.lower() in name.lower()][:limit]
    elif resolver == "case_report_status":
        rows = [{"value": value, "label": value.replace("_", " ").title()} for value in ("complete", "incomplete", "not_classified") if not q or q.lower() in value][:limit]
    else:
        rows = []
    return {"field_id": field_id, "rows": rows}


@router.get("/{report_id}")
def report_definition(report_id: str, database: Connection = Depends(connection)):
    return _report(database, report_id)


@router.get("/{report_id}/run")
def run_report(report_id: str, request: Request, database: Connection = Depends(connection)):
    return _execute(database, report_id, _query(request, database))


@router.get("/{report_id}/export")
def export_report(report_id: str, request: Request, export_format: str = Query(alias="format", pattern="^(csv|xlsx)$"), database: Connection = Depends(connection)):
    query = _query(request, database)
    query.update(page="1", page_size="500")
    rows = _execute(database, report_id, query).get("rows") or []
    if export_format == "csv":
        payload, media_type = _csv(rows), "text/csv"
    else:
        payload, media_type = _xlsx(rows), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return Response(payload, media_type=media_type, headers={"Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="{report_id}.{export_format}"'})
