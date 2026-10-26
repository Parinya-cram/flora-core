from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection

from ..clinical import flag, insert, text, update
from ..database import connection
from .auth_leaf import now_ms, require_permission

router = APIRouter(prefix="/api/config/terminology", tags=["clinical terminology"])

DOMAINS = {"observation", "fluid", "blood_product", "medication", "output", "diagnosis", "procedure"}
SYSTEMS = {
    "SNOMED_CT": "http://snomed.info/sct",
    "ICD_10": "http://hl7.org/fhir/sid/icd-10",
    "ICD_9_CM": "http://hl7.org/fhir/sid/icd-9-cm",
    "LOINC": "http://loinc.org",
    "RXNORM": "http://www.nlm.nih.gov/research/umls/rxnorm",
    "ATC": "http://www.whocc.no/atc",
    "UCUM": "http://unitsofmeasure.org",
    "TMT": "http://www.this.or.th/tmt",     # Thai Medicines Terminology (0100)
    "TMLT": "http://www.this.or.th/tmlt",   # Thai Medical Laboratory Terminology
}
FLAT_FIELDS = {
    "SNOMED_CT": ("snomed_id", "snomed_name"),
    "ICD_10": ("icd10_id", "icd10_name"),
    "ICD_9_CM": ("icd9cm_id", "icd9cm_name"),
    "LOINC": ("loinc_id", "loinc_name"),
    "RXNORM": ("rxnorm_id", "rxnorm_name"),
    "ATC": ("atc_id", "atc_name"),
    "UCUM": ("ucum_id", "ucum_name"),
}


def flattened(row: dict) -> dict:
    result = dict(row)
    codings = result.get("codings") or {}
    for system_key, (code_field, display_field) in FLAT_FIELDS.items():
        coding = codings.get(system_key) or {}
        result[code_field] = coding.get("code")
        result[display_field] = coding.get("display")
    return result


def select_concepts(database: Connection, where: str = "", params: tuple = (), limit: int | None = None) -> list[dict]:
    suffix = " LIMIT %s" if limit is not None else ""
    query_params = params + ((limit,) if limit is not None else ())
    rows = database.execute(
        f"""SELECT concept.id,concept.domain,concept.local_id,concept.local_name,concept.is_active,
          concept.created_at,concept.updated_at,
          max(item.id) AS catalog_item_id,max(item.default_unit) AS default_unit,
          max(item.category) AS group_code,max(item.group_id) AS group_id,
          coalesce(jsonb_object_agg(coding.system_key,jsonb_build_object(
            'system',coding.system_uri,'code',coding.code,'display',coding.display,'version',coding.version,
            'terminology_entry_id',coding.terminology_entry_id
          )) FILTER (WHERE coding.id IS NOT NULL),'{{}}'::jsonb) AS codings
        FROM clinical_concept concept
        LEFT JOIN clinical_concept_coding coding ON coding.concept_id=concept.id AND coding.is_preferred=1
        LEFT JOIN io_item_master item ON item.concept_id=concept.id
        {where}
        GROUP BY concept.id
        ORDER BY concept.is_active DESC,concept.domain,concept.local_name,concept.local_id{suffix}""",
        query_params,
    ).fetchall()
    return [flattened(row) for row in rows]


@router.get("")
def list_concepts(
    domain: str = "",
    q: str = "",
    include_inactive: bool = False,
    limit: int = Query(500, ge=1, le=1000),
    _: dict = Depends(require_permission("case.read")),
    database: Connection = Depends(connection),
):
    clauses = ["(%s OR concept.is_active=1)"]
    params: list = [include_inactive]
    if domain:
        if domain not in DOMAINS:
            raise HTTPException(400, "invalid terminology domain")
        clauses.append("concept.domain=%s")
        params.append(domain)
    if q.strip():
        like = f"%{q.strip()}%"
        clauses.append("(concept.local_id ILIKE %s OR concept.local_name ILIKE %s OR EXISTS (SELECT 1 FROM clinical_concept_coding lookup WHERE lookup.concept_id=concept.id AND (lookup.code ILIKE %s OR coalesce(lookup.display,'') ILIKE %s)))")
        params.extend((like, like, like, like))
    return {"rows": select_concepts(database, "WHERE " + " AND ".join(clauses), tuple(params), limit)}


@router.get("/releases")
def list_releases(
    _: dict = Depends(require_permission("case.read")),
    database: Connection = Depends(connection),
):
    rows = database.execute(
        """SELECT id,system_key,system_uri,edition,version,release_date,source_uri,license_name,license_uri,
          status,imported_at,entry_count,metadata FROM terminology_release
          ORDER BY status='active' DESC,system_key,release_date DESC NULLS LAST,version DESC"""
    ).fetchall()
    return {"rows": rows}


@router.get("/catalog/search")
def search_catalog(
    q: str = Query(min_length=1, max_length=160),
    domain: str = "",
    system_key: str = "",
    limit: int = Query(30, ge=1, le=100),
    _: dict = Depends(require_permission("case.read")),
    database: Connection = Depends(connection),
):
    if domain and domain not in {"diagnosis","procedure","observation","medication","unit"}:
        raise HTTPException(400, "invalid terminology catalog domain")
    query = q.strip()
    like = f"%{query}%"
    prefix = f"{query}%"
    rows = database.execute(
        """SELECT entry.id,entry.domain,entry.code,entry.display,entry.display_th,entry.definition,entry.parent_code,
          entry.is_billable,entry.metadata,release.id AS release_id,release.system_key,release.system_uri,
          release.edition,release.version,release.release_date
        FROM terminology_entry entry JOIN terminology_release release ON release.id=entry.release_id
        WHERE release.status='active' AND entry.is_active=1
          AND (%s='' OR entry.domain=%s) AND (%s='' OR release.system_key=%s)
          AND (entry.code ILIKE %s OR entry.display ILIKE %s OR coalesce(entry.display_th,'') ILIKE %s
            OR EXISTS (SELECT 1 FROM terminology_synonym synonym WHERE synonym.entry_id=entry.id AND synonym.term ILIKE %s))
        ORDER BY (upper(entry.code)=upper(%s)) DESC,(entry.code ILIKE %s) DESC,(entry.display ILIKE %s) DESC,
          length(entry.display),entry.code LIMIT %s""",
        (domain,domain,system_key,system_key,like,like,like,like,query,prefix,prefix,limit),
    ).fetchall()
    return {"rows": rows}


@router.post("/catalog/{entry_id}/link/{concept_id}")
def link_catalog_entry(
    entry_id: int,
    concept_id: int,
    _: dict = Depends(require_permission("clinical_master.manage")),
    database: Connection = Depends(connection),
):
    entry = database.execute(
        """SELECT entry.*,release.system_key,release.system_uri,release.version FROM terminology_entry entry
          JOIN terminology_release release ON release.id=entry.release_id WHERE entry.id=%s AND entry.is_active=1""",
        (entry_id,),
    ).fetchone()
    concept = database.execute("SELECT * FROM clinical_concept WHERE id=%s", (concept_id,)).fetchone()
    if not entry or not concept:
        raise HTTPException(404, "terminology entry or local concept not found")
    if entry["domain"] != concept["domain"] and not (entry["domain"] == "unit" and concept["domain"] in {"observation","fluid","blood_product","medication","output"}):
        raise HTTPException(400, "terminology domain does not match local concept")
    coding_key = "ICD_10" if entry["system_key"] in {"ICD_10_TM","ICD_10_CM","ICD_10_WHO"} else entry["system_key"]
    if coding_key not in SYSTEMS:
        raise HTTPException(400, "terminology system cannot be linked to a local concept")
    database.execute(
        """INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,version,is_preferred,terminology_entry_id,created_at,updated_at)
          VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s,%s)
          ON CONFLICT(concept_id,system_key,code) DO UPDATE SET display=excluded.display,version=excluded.version,
            terminology_entry_id=excluded.terminology_entry_id,is_preferred=1,updated_at=excluded.updated_at""",
        (concept_id,coding_key,entry["system_uri"],entry["code"],entry["display"],entry["version"],entry_id,now_ms(),now_ms()),
    )
    return {"ok":True,"concept_id":concept_id,"entry_id":entry_id}


def concept_values(payload: dict, old: dict | None = None) -> dict:
    old = old or {}
    domain = text(payload.get("domain", old.get("domain")))
    if domain not in DOMAINS:
        raise HTTPException(400, "valid terminology domain required")
    local_id = text(payload.get("local_id", old.get("local_id")))
    local_name = text(payload.get("local_name", old.get("local_name")))
    if not local_id or not local_name:
        raise HTTPException(400, "local_id and local_name required")
    return {
        "domain": domain,
        "local_id": local_id,
        "local_name": local_name,
        "is_active": flag(payload.get("is_active", old.get("is_active", 1))),
        "updated_at": now_ms(),
    }


def replace_codings(database: Connection, concept_id: int, payload: dict) -> None:
    current = now_ms()
    nested = payload.get("codings") if isinstance(payload.get("codings"), dict) else {}
    for system_key, (code_field, display_field) in FLAT_FIELDS.items():
        nested_value = nested.get(system_key) if isinstance(nested.get(system_key), dict) else {}
        code = text(payload.get(code_field, nested_value.get("code")))
        display = text(payload.get(display_field, nested_value.get("display")))
        version = text(nested_value.get("version"))
        database.execute("DELETE FROM clinical_concept_coding WHERE concept_id=%s AND system_key=%s", (concept_id, system_key))
        if code:
            database.execute(
                """INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,version,is_preferred,created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s)""",
                (concept_id, system_key, SYSTEMS[system_key], code, display, version, current, current),
            )


def link_local_catalogs(database: Connection, concept: dict, payload: dict | None = None) -> None:
    payload = payload or {}
    domain = concept["domain"]
    if domain in {"medication", "fluid", "blood_product", "output"}:
        kind = "med" if domain == "medication" else "fluid" if domain == "blood_product" else domain
        raw_group_id = payload.get("group_id")
        group = None
        if raw_group_id not in (None, ""):
            group = database.execute("SELECT id,code,kind FROM io_group_master WHERE id=%s", (int(raw_group_id),)).fetchone()
            if group is None or group["kind"] != kind:
                raise HTTPException(400, "valid group required for this clinical domain")
        elif domain == "blood_product":
            group = database.execute("SELECT id,code,kind FROM io_group_master WHERE code='bloodProduct'").fetchone()
        current = database.execute("SELECT * FROM io_item_master WHERE concept_id=%s ORDER BY id LIMIT 1", (concept["id"],)).fetchone()
        if current is None:
            category_clause = " AND lower(coalesce(category,''))='bloodproduct'" if domain == "blood_product" else " AND lower(coalesce(category,''))<>'bloodproduct'" if domain == "fluid" else ""
            current = database.execute(f"SELECT * FROM io_item_master WHERE kind=%s AND code=%s{category_clause} ORDER BY id LIMIT 1", (kind, concept["local_id"])).fetchone()
        default_unit = text(payload.get("default_unit", current.get("default_unit") if current else "")) or ("mg" if kind == "med" else "ml")
        category = group["code"] if group else text(payload.get("group_code", current.get("category") if current else ""))
        group_id = group["id"] if group else (current.get("group_id") if current else None)
        values = {"concept_id": concept["id"], "kind": kind, "code": concept["local_id"], "name": concept["local_name"], "default_unit": default_unit, "category": category, "group_id": group_id, "is_active": concept["is_active"], "updated_at": now_ms()}
        if current:
            update(database, "io_item_master", current["id"], values)
        else:
            insert(database, "io_item_master", {**values, "created_at": now_ms()})
    if domain == "observation":
        database.execute(
            """INSERT INTO clinical_parameter_master(param_key,concept_id,display_name,is_active,created_at,updated_at)
            VALUES (%s,%s,%s,%s,%s,%s)
            ON CONFLICT(param_key) DO UPDATE SET concept_id=excluded.concept_id,display_name=excluded.display_name,is_active=excluded.is_active,updated_at=excluded.updated_at""",
            (concept["local_id"], concept["id"], concept["local_name"], concept["is_active"], now_ms(), now_ms()),
        )


def select_parameters(database: Connection) -> list[dict]:
    return database.execute(
        """SELECT parameter.id,parameter.param_key,parameter.concept_id,
          coalesce(parameter.short_name,parameter.display_name) AS short_name,
          parameter.display_name,parameter.value_type,parameter.unit,parameter.is_active,
          parameter.display_order,parameter.table_group,parameter.show_in_table,
          parameter.chart_group_key,parameter.chart_label,parameter.chart_style,
          parameter.chart_color,parameter.chart_marker,
          parameter.show_in_chart,parameter.chart_default_visible,parameter.source_aliases,
          concept.local_id,concept.local_name,
          coalesce(jsonb_object_agg(coding.system_key,jsonb_build_object(
            'system',coding.system_uri,'code',coding.code,'display',coding.display,'version',coding.version
          )) FILTER (WHERE coding.id IS NOT NULL),'{}'::jsonb) AS codings
        FROM clinical_parameter_master parameter
        LEFT JOIN clinical_concept concept ON concept.id=parameter.concept_id
        LEFT JOIN clinical_concept_coding coding ON coding.concept_id=concept.id AND coding.is_preferred=1
        GROUP BY parameter.id,concept.id
        ORDER BY parameter.display_order,parameter.param_key"""
    ).fetchall()


@router.get("/parameters")
def list_parameters(
    _: dict = Depends(require_permission("case.read")),
    database: Connection = Depends(connection),
):
    return {"rows": select_parameters(database)}


@router.put("/parameters/{param_key}")
def edit_parameter(
    param_key: str,
    payload: dict = Body(...),
    _: dict = Depends(require_permission("clinical_master.manage")),
    database: Connection = Depends(connection),
):
    old = database.execute("SELECT * FROM clinical_parameter_master WHERE param_key=%s", (param_key,)).fetchone()
    if not old:
        raise HTTPException(404, "observation parameter not found")
    table_group = text(payload.get("table_group", old["table_group"]))
    if table_group not in {"core", "set", "measured"}:
        raise HTTPException(400, "invalid table group")
    chart_style = text(payload.get("chart_style", old["chart_style"])) or None
    if chart_style not in {None, "line", "point", "range"}:
        raise HTTPException(400, "invalid chart style")
    chart_color = text(payload.get("chart_color", old["chart_color"])).upper() or None
    if chart_color and (len(chart_color) != 7 or chart_color[0] != "#" or any(character not in "0123456789ABCDEF" for character in chart_color[1:])):
        raise HTTPException(400, "chart color must be a six-digit hex color")
    chart_marker = text(payload.get("chart_marker", old["chart_marker"])) or None
    if chart_marker not in {None, "circle", "heart", "diamond", "square", "triangle", "range"}:
        raise HTTPException(400, "invalid chart marker")
    try:
        display_order = int(payload.get("display_order", old["display_order"]))
    except (TypeError, ValueError) as cause:
        raise HTTPException(400, "display order must be a number") from cause
    values = {
        "short_name": text(payload.get("short_name", old["short_name"])) or old["display_name"],
        "display_order": display_order,
        "table_group": table_group,
        "show_in_table": flag(payload.get("show_in_table", old["show_in_table"])),
        # A chart group encodes renderer semantics (line/range/point), so it is
        # assigned by a migration or renderer upgrade rather than arbitrary UI input.
        "chart_group_key": old["chart_group_key"],
        "chart_label": text(payload.get("chart_label", old["chart_label"])) or None,
        "chart_style": chart_style,
        "chart_color": chart_color,
        "chart_marker": chart_marker,
        "show_in_chart": flag(payload.get("show_in_chart", old["show_in_chart"])) if old["chart_group_key"] else 0,
        "chart_default_visible": flag(payload.get("chart_default_visible", old["chart_default_visible"])) if old["chart_group_key"] else 0,
        "updated_at": now_ms(),
    }
    if values["show_in_chart"] and not values["chart_group_key"]:
        raise HTTPException(400, "chart group is required when chart display is enabled")
    with database.transaction():
        update(database, "clinical_parameter_master", old["id"], values)
        if old["chart_group_key"]:
            database.execute(
                """UPDATE clinical_parameter_master SET show_in_chart=%s,chart_default_visible=%s,chart_color=%s,chart_marker=%s,updated_at=%s
                WHERE chart_group_key=%s""",
                (values["show_in_chart"], values["chart_default_visible"], values["chart_color"], values["chart_marker"], values["updated_at"], old["chart_group_key"]),
            )
    return {"ok": True, "row": next(row for row in select_parameters(database) if row["param_key"] == param_key)}


@router.post("")
def create_concept(payload: dict = Body(...), _: dict = Depends(require_permission("clinical_master.manage")), database: Connection = Depends(connection)):
    values = concept_values(payload)
    with database.transaction():
        try:
            row = insert(database, "clinical_concept", {**values, "created_at": now_ms()})
        except Exception as cause:
            if getattr(cause, "sqlstate", "") == "23505":
                raise HTTPException(409, "local ID already exists in this domain") from cause
            raise
        replace_codings(database, row["id"], payload)
        link_local_catalogs(database, row, payload)
    return {"ok": True, "row": select_concepts(database, "WHERE concept.id=%s", (row["id"],))[0]}


@router.put("/{concept_id}")
def edit_concept(concept_id: int, payload: dict = Body(...), _: dict = Depends(require_permission("clinical_master.manage")), database: Connection = Depends(connection)):
    old = database.execute("SELECT * FROM clinical_concept WHERE id=%s", (concept_id,)).fetchone()
    if not old:
        raise HTTPException(404, "clinical concept not found")
    values = concept_values(payload, old)
    with database.transaction():
        try:
            row = update(database, "clinical_concept", concept_id, values)
        except Exception as cause:
            if getattr(cause, "sqlstate", "") == "23505":
                raise HTTPException(409, "local ID already exists in this domain") from cause
            raise
        replace_codings(database, concept_id, payload)
        link_local_catalogs(database, row, payload)
    return {"ok": True, "row": select_concepts(database, "WHERE concept.id=%s", (concept_id,))[0]}


@router.delete("/{concept_id}")
def deactivate_concept(concept_id: int, _: dict = Depends(require_permission("clinical_master.manage")), database: Connection = Depends(connection)):
    row = database.execute("UPDATE clinical_concept SET is_active=0,updated_at=%s WHERE id=%s RETURNING *", (now_ms(), concept_id)).fetchone()
    if not row:
        raise HTTPException(404, "clinical concept not found")
    link_local_catalogs(database, row)
    return {"ok": True, "deactivated": 1}
