"""AI Studio (/api/ai-studio): chat with the shared AI service about Canopy archive data.

The model answers in text and may add visuals:

  <artifact title="...">
    <data name="cases">{ Report Studio spec }</data>
    <view> self-contained HTML that reads FLORA.rows("cases") </view>
  </artifact>

Visuals keep their queries, never the data: each render runs the queries again (with the viewer's
ward scope), so a kept visual shows current data. To answer with real numbers the model may run
<query name="...">{spec}</query> first; only aggregate (statistics) queries without patient
identifiers are allowed there, because their results are sent to the AI host. Patient-level rows
only ever reach the sandboxed visual in the user's browser.

Chat sessions are private to their owner; kept visuals (snippets) can be shared with every AI
Studio user and always run with the viewer's own ward scope.
"""
from __future__ import annotations

import json
import re
import time
import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import ai_service
from ..database import pool
from .auth_canopy import read_token
from .auth_leaf import attach_entitlements
from .canopy_reports import _source_system, _studio_catalog, _studio_compile, studio_rows
from .studio_access import can_author

router = APIRouter(prefix="/api/ai-studio", tags=["ai studio"])

DATASET = "innovian_cases"
IDENTIFIER_FIELDS = {"patient.hn", "patient.name", "case.encounter_number"}
MAX_QUERY_ROUNDS = 3
HISTORY_MESSAGES = 16
QUERY_RE = re.compile(r'<query\s+name="([^"]{1,60})"\s*>(.*?)</query>', re.S)
ARTIFACT_RE = re.compile(r'<artifact(?:\s+title="([^"]*)")?\s*>(.*?)</artifact>', re.S)
DATA_RE = re.compile(r'<data\s+name="([A-Za-z_][A-Za-z0-9_]{0,40})"\s*>(.*?)</data>', re.S)
VIEW_RE = re.compile(r"<view>(.*)</view>", re.S)


def _now() -> int:
    return int(time.time() * 1000)


# Access --------------------------------------------------------------------------------------
def _user(request: Request) -> dict[str, Any]:
    """The signed-in user, loaded on a short connection (chat requests outlive the AI call)."""
    payload = read_token(request)
    with pool.connection() as database:
        row = database.execute(
            "SELECT id,username,name,role,must_change_password,is_active FROM auth_user WHERE id=%s", (payload["sub"],)
        ).fetchone()
        if not row or not row["is_active"]:
            raise HTTPException(status_code=401, detail="sign in required")
        user = attach_entitlements(database, row)
    if user.get("must_change_password"):
        raise HTTPException(status_code=403, detail="password change required")
    if not (can_author(user) or "report.generate" in user.get("_permissions", [])):
        raise HTTPException(status_code=403, detail="AI Studio needs the report.generate permission")
    return user


def _scope(request: Request, database, params: dict[str, Any] | None = None) -> dict[str, str]:
    query = {"_source": _source_system(request, database)}
    for key in ("from", "to"):
        value = str((params or {}).get(key) or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            query[key] = value
    return query


def _own_session(database, session_id: str, user: dict[str, Any]) -> dict[str, Any]:
    row = database.execute("SELECT * FROM ai_studio_session WHERE id::text=%s AND owner_user_id=%s", (session_id, user["id"])).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat not found")
    return row


# Prompt --------------------------------------------------------------------------------------
def _system_prompt(fields: list[dict[str, Any]], scope_note: str) -> str:
    catalog = "\n".join(
        f"- {f['id']} | {f['label']} | {f['data_type']}{' | multi-value' if f['cardinality'] == 'multi' else ''}"
        f" | uses: {','.join(f['allowed_uses'])} | filter ops: {','.join(f['operators'])}"
        for f in sorted(fields, key=lambda row: row["id"])
    )
    return f"""You are Flora AI Studio, an analytics assistant inside ESM Flora Canopy, a hospital's central view of
anaesthesia / perioperative and ICU cases (migrated Innovian archive). Today is {date.today().isoformat()}. {scope_note}
Reply in the user's language (Thai or English). Be concise and clinically careful; say when data is missing.

DATA. You never see the database directly. You describe queries as a JSON "spec" over these case fields:
{catalog}

Spec format (one row per case for "list", one row per group for "stats"):
{{"dataset":"{DATASET}","view":"stats"|"list",
 "groups":[{{"field":"case.started_at","bucket":"day|week|month|quarter|year","label":"Month"}}],      (stats, max 3)
 "measures":[{{"agg":"count_cases|count_patients|pct_cases|count_filled|avg|median|p90|min|max|sum|stddev","field":"<number field, not for count_cases/count_patients/pct_cases>","label":"Cases"}}],
 "columns":[{{"field":"patient.asa_status","label":"ASA"}}],                                              (list)
 "filters":[{{"field":"...","op":"<one of the field's filter ops>","value":"x" | ["a","b"] | ["2026-01-01","2026-03-31"]}}],
 "sort":{{"key":"g0|m0|c0","dir":"asc|desc"}},"limit":10}}
ALWAYS give every group, measure and column a short "label": results are keyed by those labels.
Multi-value fields count a case once in every group it has a value for.

ANSWERING WITH NUMBERS. To look at data before answering, reply with ONLY one or more
<query name="q1">{{spec}}</query> blocks and nothing else. You will get the results and can then answer.
Queries must be "stats" view and must not group by patient identifiers (HN, name, encounter number).
Never invent numbers you did not query.

VISUALS. To show a chart, table or dashboard, add an artifact to your answer:
<artifact title="Cases by month">
<data name="cases">{{spec}}</data>
<view>
<div id="chart"></div>
<script>
  FloraChart.bar("#chart", FLORA.series("cases", {{x: "Month", y: "Cases"}}));
</script>
</view>
</artifact>
Rules for <view>: plain HTML/CSS/JS, no external scripts, fonts, images or network (blocked). NEVER write data values
into the HTML: always read them at run time, so the visual can be re-run later on new data.
Runtime available in the view:
- FLORA.rows(name) -> array of objects keyed by your labels; FLORA.columns(name) -> [{{label, kind, type}}]
- FLORA.series(name, {{x, y, by?}}) -> {{labels, series:[{{name, values}}]}} (by = a second group label to split series)
- FLORA.params -> {{from, to}} period chosen by the viewer (may be empty); FLORA.theme -> colours
- FLORA.leaf -> the Leaf the board follows ({{leaf_id, name, room_name, unit_name}}) or null; FLORA.case -> its current case or null
  ({{case_code, hn, patient_name, operation, surgeon, anaesthetist, scheduled_at, duration_min, milestones:{{patient_in,
  anesthesia_start, incision, surgery_end, anesthesia_end, patient_out}}}}, times in epoch ms or null); FLORA.cases -> all
  current cases; FLORA.next -> next booked cases [{{scheduled_at, operation, surgeon, patient_name}}]. Re-rendered when it changes;
  when FLORA.case is null show "no patient" and FLORA.next[0]. Tick timers yourself with setInterval.
- FloraChart.bar(el, {{labels, series, stacked?, horizontal?, height?}}), FloraChart.line(el, {{labels, series, height?}}),
  FloraChart.pie(el, {{labels, values, donut?}}), FloraChart.table(el, name), FloraChart.kpi(el, [{{label, value, note?}}])
  (el = CSS selector or element; FloraChart.pie can take FLORA.series(...) output too)
- CSS variables: --bg --panel --text --muted --border --accent. Keep visuals clean, readable in light and dark.
- Visuals are also shown scaled into dashboard cells of any size: let FloraChart pick heights (omit height), avoid fixed
  pixel widths/heights in your own CSS, and keep one visual focused (a long table makes it scroll in small cells).
Patient-level "list" specs are allowed in visuals (they render only in the user's browser).
Prefer one focused artifact per answer; explain briefly in text what it shows."""


def _history(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    recent = messages[-HISTORY_MESSAGES:]
    assistant_positions = [index for index, row in enumerate(recent) if row["role"] == "assistant"]
    keep_full = set(assistant_positions[-2:])
    out = []
    for index, row in enumerate(recent):
        if row["role"] == "user":
            out.append({"role": "user", "content": row["content"]})
            continue
        raw = row["raw"] or row["content"]
        if index not in keep_full:
            raw = VIEW_RE.sub("<view>(HTML omitted)</view>", raw)
        out.append({"role": "assistant", "content": raw or "(no answer)"})
    # Providers want alternating turns starting with the user.
    merged: list[dict[str, str]] = []
    for item in out:
        if merged and merged[-1]["role"] == item["role"]:
            merged[-1]["content"] += "\n\n" + item["content"]
        else:
            merged.append(dict(item))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    return merged


def _json(text: str) -> Any:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    return json.loads(text)


def _run_model_queries(request: Request, blocks: list[tuple[str, str]], log: list[dict[str, Any]]) -> str:
    parts = []
    with pool.connection() as database:
        query = _scope(request, database)
        for name, body in blocks:
            entry: dict[str, Any] = {"name": name}
            try:
                spec = _json(body)
                entry["spec"] = spec
                if not isinstance(spec, dict) or spec.get("view") != "stats":
                    raise ValueError("only stats queries can be sent to the AI service")
                if any(isinstance(g, dict) and g.get("field") in IDENTIFIER_FIELDS for g in spec.get("groups") or []):
                    raise ValueError("grouping by patient identifiers is not allowed")
                result = studio_rows(database, spec, query, max_rows=200)
                entry["rows"] = len(result["rows"])
                shown = result["rows"][:80]
                parts.append(f'<result name="{name}" rows="{len(result["rows"])}"{" truncated" if len(result["rows"]) > 80 or result["truncated"] else ""}>\n'
                             f"{json.dumps(shown, ensure_ascii=False, default=str)}\n</result>")
            except HTTPException as error:
                entry["error"] = str(error.detail)
                parts.append(f'<result name="{name}" error="{entry["error"]}"/>')
            except (ValueError, TypeError) as error:
                entry["error"] = str(error)
                parts.append(f'<result name="{name}" error="{entry["error"]}"/>')
            log.append(entry)
    return "Query results (" + ("filtered to " + query["_source"]) + "):\n" + "\n".join(parts)


def _artifacts(request: Request, raw: str) -> tuple[str, list[dict[str, Any]]]:
    """Visible text with [[artifact:N]] markers, and the parsed visuals (queries checked)."""
    artifacts: list[dict[str, Any]] = []

    def take(match: re.Match[str]) -> str:
        body = match.group(2)
        view = VIEW_RE.search(body)
        data, errors = {}, []
        for name, spec_text in DATA_RE.findall(body):
            try:
                data[name] = _json(spec_text)
            except ValueError as error:
                errors.append(f"{name}: {error}")
        artifact = {"title": (match.group(1) or "Visual").strip()[:160], "html": (view.group(1).strip() if view else ""), "data": data}
        if not artifact["html"]:
            errors.append("the visual has no <view>")
        if errors:
            artifact["error"] = "; ".join(errors)
        artifacts.append(artifact)
        return f"\n\n[[artifact:{len(artifacts) - 1}]]\n\n"

    text = ARTIFACT_RE.sub(take, raw)
    text = QUERY_RE.sub("", text)
    if artifacts:
        with pool.connection() as database:
            query = _scope(request, database)
            for artifact in artifacts:
                for name, spec in artifact["data"].items():
                    try:
                        _studio_compile(database, spec, query)
                    except HTTPException as error:
                        artifact["error"] = f"{artifact.get('error', '')}; {name}: {error.detail}".strip("; ")
    return re.sub(r"\n{3,}", "\n\n", text).strip(), artifacts


# Sessions ------------------------------------------------------------------------------------
class SessionInput(BaseModel):
    title: str = Field(default="New chat", min_length=1, max_length=160)


class MessageInput(BaseModel):
    content: str = Field(min_length=1, max_length=8000)


@router.get("/sessions")
def list_sessions(request: Request):
    user = _user(request)
    with pool.connection() as database:
        rows = database.execute(
            """SELECT s.id,s.title,s.created_at,s.updated_at,count(m.id) AS messages
               FROM ai_studio_session s LEFT JOIN ai_studio_message m ON m.session_id=s.id
               WHERE s.owner_user_id=%s GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 200""", (user["id"],)
        ).fetchall()
    return {"rows": rows}


@router.post("/sessions")
def create_session(payload: SessionInput, request: Request):
    user = _user(request)
    now, session_id = _now(), uuid.uuid4()
    with pool.connection() as database:
        database.execute("INSERT INTO ai_studio_session(id,owner_user_id,title,created_at,updated_at) VALUES (%s,%s,%s,%s,%s)",
                         (session_id, user["id"], payload.title.strip(), now, now))
        return _own_session(database, str(session_id), user)


@router.get("/sessions/{session_id}")
def get_session(session_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        session = _own_session(database, session_id, user)
        messages = database.execute(
            """SELECT id,seq,role,content,artifacts,queries,error,created_at FROM ai_studio_message
               WHERE session_id=%s ORDER BY seq""", (session["id"],)
        ).fetchall()
    return {**session, "messages": messages}


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, payload: SessionInput, request: Request):
    user = _user(request)
    with pool.connection() as database:
        session = _own_session(database, session_id, user)
        database.execute("UPDATE ai_studio_session SET title=%s,updated_at=%s WHERE id=%s", (payload.title.strip(), _now(), session["id"]))
        return _own_session(database, session_id, user)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        session = _own_session(database, session_id, user)
        # Kept visuals survive: their session link is cleared (ON DELETE SET NULL).
        database.execute("DELETE FROM ai_studio_session WHERE id=%s", (session["id"],))
    return {"id": session_id, "deleted": True}


@router.post("/sessions/{session_id}/messages")
def send_message(session_id: str, payload: MessageInput, request: Request):
    user = _user(request)
    text = payload.content.strip()
    # 1. Store the question and gather what the model needs (short connection).
    with pool.connection() as database:
        session = _own_session(database, session_id, user)
        previous = database.execute("SELECT role,content,raw FROM ai_studio_message WHERE session_id=%s ORDER BY seq", (session["id"],)).fetchall()
        now = _now()
        database.execute(
            """INSERT INTO ai_studio_message(id,session_id,seq,role,content,raw,created_at)
               VALUES (%s,%s,(SELECT coalesce(max(seq),0)+1 FROM ai_studio_message WHERE session_id=%s),'user',%s,%s,%s)""",
            (uuid.uuid4(), session["id"], session["id"], text, text, now),
        )
        title = session["title"]
        if not previous and title == "New chat":
            title = (text.splitlines()[0] if text else title)[:60]
        database.execute("UPDATE ai_studio_session SET title=%s,updated_at=%s WHERE id=%s", (title, now, session["id"]))
        config = ai_service.load(database)
        fields, _ = _studio_catalog(database, DATASET)
        source = _source_system(request, database)
    scope_note = ("Data scope: the synthetic demo ward." if source != "innovian" else "Data scope: the hospital's migrated Innovian archive.")
    system = _system_prompt(fields, scope_note)
    conversation = _history([*previous, {"role": "user", "content": text, "raw": text}])

    # 2. Ask the model, letting it run aggregate queries first (no connection held while waiting).
    raw, error, log = "", None, []
    try:
        for round_number in range(MAX_QUERY_ROUNDS + 1):
            raw = ai_service.complete(config, system, conversation)
            blocks = QUERY_RE.findall(raw)
            # Stop when the model answered (no queries, or a full answer that merely mentions one) or the rounds are used up.
            answered = not blocks or (ARTIFACT_RE.search(raw) is not None and not raw.strip().startswith("<query"))
            if answered or round_number == MAX_QUERY_ROUNDS:
                break
            results = _run_model_queries(request, blocks, log)
            conversation = [*conversation, {"role": "assistant", "content": raw},
                            {"role": "user", "content": results + "\n\nNow answer the original question."}]
        content, artifacts = _artifacts(request, raw)
        if not content and not artifacts:
            content = "(The AI service returned an empty answer.)"
    except ai_service.AiServiceError as failure:
        content, artifacts, error = "", [], str(failure)

    # 3. Store the answer.
    with pool.connection() as database:
        message_id = uuid.uuid4()
        database.execute(
            """INSERT INTO ai_studio_message(id,session_id,seq,role,content,raw,artifacts,queries,error,created_at)
               VALUES (%s,%s,(SELECT coalesce(max(seq),0)+1 FROM ai_studio_message WHERE session_id=%s),'assistant',%s,%s,%s,%s,%s,%s)""",
            (message_id, session["id"], session["id"], content, raw, Jsonb(artifacts), Jsonb(log), error, _now()),
        )
        database.execute("UPDATE ai_studio_session SET updated_at=%s WHERE id=%s", (_now(), session["id"]))
    return get_session(session_id, request)


# Rendering -----------------------------------------------------------------------------------
class RenderInput(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, str] = Field(default_factory=dict)


def _render(request: Request, data: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    with pool.connection() as database:
        query = _scope(request, database, params)
        for name, spec in list(data.items())[:8]:
            try:
                out[name] = studio_rows(database, spec, query)
            except HTTPException as error:
                out[name] = {"error": str(error.detail), "columns": [], "rows": []}
    return {"data": out, "params": {key: query[key] for key in ("from", "to") if key in query}, "ranAt": _now()}


@router.post("/render")
def render(payload: RenderInput, request: Request):
    _user(request)
    return _render(request, payload.data, payload.params)


# Kept visuals (snippets) ---------------------------------------------------------------------
class ArtifactInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    html: str = Field(min_length=1, max_length=200_000)
    data: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None


class ArtifactPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    shared: bool | None = None


ARTIFACT_COLUMNS = """a.id,a.title,a.html,a.data,a.shared,a.session_id,a.created_at,a.updated_at,a.last_run_at,
  a.owner_user_id,coalesce(u.name,u.username) AS owner_name"""


def _visible_artifact(database, artifact_id: str, user: dict[str, Any]) -> dict[str, Any]:
    row = database.execute(
        f"SELECT {ARTIFACT_COLUMNS} FROM ai_studio_artifact a JOIN auth_user u ON u.id=a.owner_user_id "
        "WHERE a.id::text=%s AND (a.owner_user_id=%s OR a.shared)", (artifact_id, user["id"])
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Visual not found")
    return {**row, "mine": row["owner_user_id"] == user["id"]}


def _owned_artifact(database, artifact_id: str, user: dict[str, Any]) -> dict[str, Any]:
    row = _visible_artifact(database, artifact_id, user)
    if not row["mine"]:
        raise HTTPException(status_code=403, detail="Only the owner can change this visual; copy it to make your own")
    return row


@router.get("/artifacts")
def list_artifacts(request: Request):
    user = _user(request)
    with pool.connection() as database:
        rows = database.execute(
            f"""SELECT {ARTIFACT_COLUMNS} FROM ai_studio_artifact a JOIN auth_user u ON u.id=a.owner_user_id
                WHERE a.owner_user_id=%s OR a.shared ORDER BY a.updated_at DESC LIMIT 300""", (user["id"],)
        ).fetchall()
    return {"rows": [{**row, "mine": row["owner_user_id"] == user["id"]} for row in rows]}


@router.post("/artifacts")
def keep_artifact(payload: ArtifactInput, request: Request):
    user = _user(request)
    now, artifact_id = _now(), uuid.uuid4()
    with pool.connection() as database:
        session_id = None
        if payload.session_id:
            session_id = _own_session(database, payload.session_id, user)["id"]
        query = _scope(request, database)
        for name, spec in payload.data.items():
            _studio_compile(database, spec, query)
        database.execute(
            """INSERT INTO ai_studio_artifact(id,owner_user_id,session_id,title,html,data,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (artifact_id, user["id"], session_id, payload.title.strip(), payload.html, Jsonb(payload.data), now, now),
        )
        return _visible_artifact(database, str(artifact_id), user)


@router.patch("/artifacts/{artifact_id}")
def update_artifact(artifact_id: str, payload: ArtifactPatch, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _owned_artifact(database, artifact_id, user)
        database.execute(
            "UPDATE ai_studio_artifact SET title=coalesce(%s,title),shared=coalesce(%s,shared),updated_at=%s WHERE id=%s",
            (payload.title.strip() if payload.title else None, payload.shared, _now(), row["id"]),
        )
        return _visible_artifact(database, artifact_id, user)


@router.post("/artifacts/{artifact_id}/copy")
def copy_artifact(artifact_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _visible_artifact(database, artifact_id, user)
    return keep_artifact(ArtifactInput(title=f"{row['title']} (copy)"[:160], html=row["html"], data=row["data"]), request)


@router.delete("/artifacts/{artifact_id}")
def delete_artifact(artifact_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _owned_artifact(database, artifact_id, user)
        database.execute("DELETE FROM ai_studio_artifact WHERE id=%s", (row["id"],))
    return {"id": artifact_id, "deleted": True}


@router.post("/artifacts/{artifact_id}/run")
def run_artifact(artifact_id: str, payload: RenderInput, request: Request):
    """Re-run a kept visual's queries on current data (the viewer's ward scope and period)."""
    user = _user(request)
    with pool.connection() as database:
        row = _visible_artifact(database, artifact_id, user)
        if row["mine"]:
            database.execute("UPDATE ai_studio_artifact SET last_run_at=%s WHERE id=%s", (_now(), row["id"]))
    return _render(request, row["data"] or {}, payload.params)


# Dashboards ----------------------------------------------------------------------------------
WIDGET_TYPES = {"snippet", "html", "image", "text", "system_status", "active_cases", "gateway_alerts", "case_counts", "clock", "case_timer"}
MAX_GRID = 6
MAX_IMAGE_BYTES = 1_500_000
MAX_BOARD_BYTES = 6_000_000


class DashboardInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    cols: int = Field(default=3, ge=1, le=MAX_GRID)
    rows: int = Field(default=3, ge=1, le=MAX_GRID)
    row_height: int = Field(default=220, ge=120, le=480)
    widgets: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_GRID * MAX_GRID)
    # {"leafId": "..."}: the board follows that Leaf's current case (see app/leaf_context.py).
    settings: dict[str, Any] = Field(default_factory=dict)


def _clean_settings(payload: DashboardInput) -> dict[str, Any]:
    leaf_id = str(payload.settings.get("leafId") or "").strip()[:120]
    return {"leafId": leaf_id} if leaf_id else {}


class ShareInput(BaseModel):
    shared: bool


def _clean_widgets(payload: DashboardInput) -> list[dict[str, Any]]:
    """Every widget inside the grid, no two overlapping, known types, bounded config."""
    taken: dict[tuple[int, int], str] = {}
    out = []
    for raw in payload.widgets:
        kind = str(raw.get("type") or "")
        if kind not in WIDGET_TYPES:
            raise HTTPException(status_code=422, detail=f"Unknown widget type: {kind}")
        try:
            x, y, w, h = (int(raw.get(key)) for key in ("x", "y", "w", "h"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="Widget position and size must be whole numbers") from None
        if w < 1 or h < 1 or x < 0 or y < 0 or x + w > payload.cols or y + h > payload.rows:
            raise HTTPException(status_code=422, detail=f"A {kind} widget does not fit in a {payload.cols}x{payload.rows} grid")
        widget_id = str(raw.get("id") or uuid.uuid4())[:64]
        for cell in ((cx, cy) for cx in range(x, x + w) for cy in range(y, y + h)):
            if cell in taken:
                raise HTTPException(status_code=422, detail="Two widgets overlap")
            taken[cell] = widget_id
        config = raw.get("config") if isinstance(raw.get("config"), dict) else {}
        if kind == "snippet" and not str(config.get("artifactId") or ""):
            config = {**config, "artifactId": ""}
        if kind == "image":
            src = str(config.get("src") or "")
            if src and not re.match(r"^(https?://|data:image/(png|jpeg|gif|webp|svg\+xml);base64,)", src):
                raise HTTPException(status_code=422, detail="Images must be an http(s) address or an uploaded picture")
            if len(src) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=422, detail="Uploaded pictures must be under about 1 MB")
        if kind == "html" and len(str(config.get("html") or "")) > 200_000:
            raise HTTPException(status_code=422, detail="HTML widgets are limited to 200 KB")
        out.append({"id": widget_id, "type": kind, "x": x, "y": y, "w": w, "h": h,
                    "title": str(raw.get("title") or "")[:160], "config": config})
    if len(json.dumps(out)) > MAX_BOARD_BYTES:
        raise HTTPException(status_code=422, detail="This dashboard is too large; use smaller pictures")
    return out


DASHBOARD_COLUMNS = """d.id,d.title,d.cols,d.rows,d.row_height,d.settings,d.shared,d.created_at,d.updated_at,d.owner_user_id,
  coalesce(u.name,u.username) AS owner_name"""


def _visible_dashboard(database, dashboard_id: str, user: dict[str, Any], *, widgets: bool = True) -> dict[str, Any]:
    row = database.execute(
        f"SELECT {DASHBOARD_COLUMNS}{',d.widgets' if widgets else ''} FROM ai_studio_dashboard d JOIN auth_user u ON u.id=d.owner_user_id "
        "WHERE d.id::text=%s AND (d.owner_user_id=%s OR d.shared)", (dashboard_id, user["id"])
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return {**row, "mine": row["owner_user_id"] == user["id"]}


def _owned_dashboard(database, dashboard_id: str, user: dict[str, Any]) -> dict[str, Any]:
    row = _visible_dashboard(database, dashboard_id, user)
    if not row["mine"]:
        raise HTTPException(status_code=403, detail="Only the owner can change this dashboard; copy it to make your own")
    return row


@router.get("/dashboards")
def list_dashboards(request: Request):
    user = _user(request)
    with pool.connection() as database:
        rows = database.execute(
            f"""SELECT {DASHBOARD_COLUMNS},jsonb_array_length(d.widgets) AS widget_count FROM ai_studio_dashboard d
                JOIN auth_user u ON u.id=d.owner_user_id WHERE d.owner_user_id=%s OR d.shared ORDER BY d.updated_at DESC LIMIT 200""",
            (user["id"],),
        ).fetchall()
    return {"rows": [{**row, "mine": row["owner_user_id"] == user["id"]} for row in rows]}


@router.get("/dashboards/{dashboard_id}")
def get_dashboard(dashboard_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        return _visible_dashboard(database, dashboard_id, user)


@router.post("/dashboards")
def create_dashboard(payload: DashboardInput, request: Request):
    user = _user(request)
    widgets, now, dashboard_id = _clean_widgets(payload), _now(), uuid.uuid4()
    with pool.connection() as database:
        database.execute(
            """INSERT INTO ai_studio_dashboard(id,owner_user_id,title,cols,rows,row_height,widgets,settings,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (dashboard_id, user["id"], payload.title.strip(), payload.cols, payload.rows, payload.row_height, Jsonb(widgets),
             Jsonb(_clean_settings(payload)), now, now),
        )
        return _visible_dashboard(database, str(dashboard_id), user)


@router.put("/dashboards/{dashboard_id}")
def save_dashboard(dashboard_id: str, payload: DashboardInput, request: Request):
    user = _user(request)
    widgets = _clean_widgets(payload)
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        database.execute(
            "UPDATE ai_studio_dashboard SET title=%s,cols=%s,rows=%s,row_height=%s,widgets=%s,settings=%s,updated_at=%s WHERE id=%s",
            (payload.title.strip(), payload.cols, payload.rows, payload.row_height, Jsonb(widgets), Jsonb(_clean_settings(payload)),
             _now(), row["id"]),
        )
        return _visible_dashboard(database, dashboard_id, user)


@router.patch("/dashboards/{dashboard_id}/share")
def share_dashboard(dashboard_id: str, payload: ShareInput, request: Request):
    """Sharing a dashboard also shares the owner's snippets placed on it, so viewers can run them."""
    user = _user(request)
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        database.execute("UPDATE ai_studio_dashboard SET shared=%s,updated_at=%s WHERE id=%s", (payload.shared, _now(), row["id"]))
        snippet_ids = [str(w["config"].get("artifactId")) for w in row["widgets"] if w.get("type") == "snippet" and (w.get("config") or {}).get("artifactId")]
        newly_shared = 0
        if payload.shared and snippet_ids:
            newly_shared = database.execute(
                """UPDATE ai_studio_artifact SET shared=true,updated_at=%s
                   WHERE id::text=ANY(%s) AND owner_user_id=%s AND NOT shared""", (_now(), snippet_ids, user["id"])
            ).rowcount
        return {**_visible_dashboard(database, dashboard_id, user), "snippetsShared": newly_shared}


@router.post("/dashboards/{dashboard_id}/copy")
def copy_dashboard(dashboard_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _visible_dashboard(database, dashboard_id, user)
    copy = DashboardInput(title=f"{row['title']} (copy)"[:160], cols=row["cols"], rows=row["rows"], row_height=row["row_height"], widgets=row["widgets"],
                          settings=row.get("settings") or {})
    return create_dashboard(copy, request)


@router.delete("/dashboards/{dashboard_id}")
def delete_dashboard(dashboard_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        database.execute("DELETE FROM ai_studio_dashboard WHERE id=%s", (row["id"],))
    return {"id": dashboard_id, "deleted": True}
