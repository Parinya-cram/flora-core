"""Leaf dictation: offline speech-to-text (relayed to leaf-stt) and form filling.

/api/stt/...            the browser streams PCM chunks; leaf-stt transcribes locally.
/api/dictation/extract  the hospital's AI service maps a transcript onto form fields.
"""
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from psycopg import Connection

from .. import ai_service
from ..database import connection
from .auth_leaf import require_permission

STT_URL = os.getenv("FLORA_STT_URL", "http://leaf-stt:8000").rstrip("/")

router = APIRouter(tags=["dictation"])


def stt(method: str, path: str, data: bytes | None = None, content_type: str = "application/json",
        timeout: float = 30) -> dict[str, Any]:
    request = urllib.request.Request(f"{STT_URL}{path}", data=data, method=method,
                                     headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = "dictation session ended" if error.code == 404 else f"speech service error ({error.code})"
        raise HTTPException(status_code=error.code if error.code == 404 else 502, detail=detail) from error
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=503, detail="speech service is not running on this Leaf") from error


@router.get("/api/stt/health")
def stt_health(_: dict = Depends(require_permission("case.read"))) -> dict:
    return stt("GET", "/health", timeout=3)


@router.post("/api/stt/sessions")
def stt_open(payload: dict[str, Any] = Body(default={}), _: dict = Depends(require_permission("case.read"))) -> dict:
    return stt("POST", "/sessions", json.dumps({"language": payload.get("language"),
                                                 "prompt": payload.get("prompt")}).encode())


@router.post("/api/stt/sessions/{session_id}/audio")
async def stt_audio(session_id: str, request: Request, _: dict = Depends(require_permission("case.read"))) -> dict:
    body = await request.body()
    if len(body) > 2_000_000:
        raise HTTPException(status_code=413, detail="audio chunk too large")
    import anyio
    return await anyio.to_thread.run_sync(
        lambda: stt("POST", f"/sessions/{session_id}/audio", body, "application/octet-stream"))


@router.post("/api/stt/sessions/{session_id}/finish")
def stt_finish(session_id: str, _: dict = Depends(require_permission("case.read"))) -> dict:
    return stt("POST", f"/sessions/{session_id}/finish", b"{}", timeout=60)


@router.delete("/api/stt/sessions/{session_id}")
def stt_cancel(session_id: str, _: dict = Depends(require_permission("case.read"))) -> dict:
    return stt("DELETE", f"/sessions/{session_id}")


EXTRACT_SYSTEM = """You fill a clinical form from a clinician's dictation (Thai, English or mixed).
You receive the form's fields as JSON and the transcript. Return ONLY a JSON object:
{"values": {"<field id>": <value>}, "unmatched": "<dictated facts that fit no field>"}
Rules:
- Fill a field only when the transcript states it. Never guess; leave other fields out.
- type "text"/"textarea": a string. Respect the field's placeholder format (e.g. dd/mm/yyyy, HH:mm).
- type "number": a number in the field's unit (convert, e.g. 1.7 m -> 170 for cm).
- type "select" or "single": exactly one string copied from that field's options.
- type "multi": a list of strings copied from that field's options (only ones the transcript states).
- Map spoken synonyms and Thai to the closest option (e.g. "ดมยาสลบ" -> "General anesthesia",
  "วัดความดันแบบ non-invasive" -> "NIBP", "นอนหงาย" -> "Supine").
- Do not change identifiers (HN, AN) unless the transcript clearly dictates them.
No prose, no markdown fences."""


def parse_json(text: str) -> dict[str, Any]:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start:end + 1])


@router.post("/api/dictation/extract")
def extract(payload: dict[str, Any] = Body(...), _: dict = Depends(require_permission("case.read")),
            database: Connection = Depends(connection)) -> dict:
    transcript = str(payload.get("transcript") or "").strip()
    fields = payload.get("fields") or []
    if not transcript:
        raise HTTPException(status_code=400, detail="transcript is empty")
    if not isinstance(fields, list) or not fields:
        raise HTTPException(status_code=400, detail="no form fields to fill")
    compact = []
    by_id: dict[str, dict[str, Any]] = {}
    for field in fields[:400]:
        if not isinstance(field, dict) or not field.get("id"):
            continue
        item = {k: field[k] for k in ("id", "label", "group", "section", "type", "options", "placeholder", "value")
                if field.get(k) not in (None, "", [])}
        compact.append(item)
        by_id[str(field["id"])] = field
    user = (f"Form: {payload.get('form') or 'clinical form'}\nFields:\n"
            f"{json.dumps(compact, ensure_ascii=False, separators=(',', ':'))}\n\nTranscript:\n{transcript}")
    try:
        reply = ai_service.complete(ai_service.load(database), EXTRACT_SYSTEM, [{"role": "user", "content": user}],
                                    max_tokens=3000, timeout=120)
    except ai_service.AiServiceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    try:
        parsed = parse_json(reply)
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail="the AI service did not return form values") from error
    values: dict[str, Any] = {}
    for key, value in (parsed.get("values") or {}).items():
        field = by_id.get(str(key))
        if field is None or value in (None, "", []):
            continue
        options = [str(o) for o in field.get("options") or []]
        kind = field.get("type")
        if kind == "multi":
            picked = [str(v) for v in (value if isinstance(value, list) else [value]) if str(v) in options]
            if picked:
                values[str(key)] = picked
        elif kind in {"select", "single"}:
            if str(value) in options:
                values[str(key)] = str(value)
        else:
            values[str(key)] = value if isinstance(value, (int, float)) else str(value)
    return {"values": values, "unmatched": str(parsed.get("unmatched") or "")}
