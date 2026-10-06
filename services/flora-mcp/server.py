"""Flora Canopy MCP server: lets AI agents read Flora case data through the public API.

Streamable HTTP at /mcp. Authenticate with a Canopy API key
(Authorization: Bearer flk_…) created under Canopy → System settings → API keys.
Every tool call goes to the Canopy public API (/api/v1) with that same key, so the
key's scopes and ward limits apply and every call lands in the API access log,
tagged with the tool name.
"""
import os
import time
from typing import Any

import httpx
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse

API_URL = os.getenv("FLORA_API_URL", "http://canopy-api:8000").rstrip("/")
READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

server = MCPServer(
    name="Flora Canopy",
    instructions=(
        "Perioperative and ICU case data from Flora Canopy, a hospital's central view of every bedside "
        "workstation (Leaf). A case is one patient's stay at a Leaf: an anaesthetic/OR or ICU episode with "
        "minute-by-minute vital signs, events, medications/fluids and clinical forms (pre-op, checklist, PACU). "
        "Wards group Leafs; your API key may be limited to some wards. Start with search_cases or list_wards, "
        "then use the case_id with get_case, get_vitals, get_case_events, get_medications or get_case_forms. "
        "Times are epoch milliseconds unless stated. This is patient data: use only what the task needs."
    ),
)


def _key(ctx: Context) -> str:
    headers = ctx.headers or {}
    authorization = headers.get("authorization") or ""
    return authorization[7:].strip() if authorization.lower().startswith("bearer ") else (headers.get("x-api-key") or "")


async def _get(ctx: Context, tool: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    query = {key: value for key, value in (params or {}).items() if value not in (None, "", [])}
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{API_URL}/api/v1{path}", params=query,
            headers={"authorization": f"Bearer {_key(ctx)}", "x-flora-client": "mcp", "x-flora-mcp-tool": tool,
                     "user-agent": "flora-mcp"},
        )
    body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    if response.status_code >= 400:
        # ToolError reaches the agent with its message (e.g. "case not found", missing scope).
        raise ToolError(body.get("error") or body.get("detail") or f"Canopy API returned {response.status_code}")
    return body


@server.tool(annotations=READ_ONLY)
async def list_wards(ctx: Context) -> dict[str, Any]:
    """Wards (care units) this API key can read, with the number of bedside Leafs in each."""
    return await _get(ctx, "list_wards", "/wards")


@server.tool(annotations=READ_ONLY)
async def search_cases(
    ctx: Context,
    ward: str | None = None,
    status: str | None = None,
    hn: str | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    """Find cases, newest first.

    ward: ward key from list_wards. status: active, discharged, archived or handed_over.
    hn: hospital number (exact). since/until: ISO 8601 bounds on the case start time.
    Returns case summaries (case_id, patient, ward, Leaf, status, start/discharge, procedure, diagnosis).
    """
    return await _get(ctx, "search_cases", "/cases", {"ward": ward, "status": status, "hn": hn, "since": since,
                                                       "until": until, "limit": max(1, min(limit, 200)), "offset": offset})


@server.tool(annotations=READ_ONLY)
async def get_case(ctx: Context, case_id: str) -> dict[str, Any]:
    """One case in detail: patient, latest vital signs, diagnoses, procedures, allergies, staff and a chart summary."""
    return await _get(ctx, "get_case", f"/cases/{case_id}")


@server.tool(annotations=READ_ONLY)
async def get_vitals(
    ctx: Context,
    case_id: str,
    parameters: list[str] | None = None,
    interval_minutes: int = 5,
    since: str | None = None,
    until: str | None = None,
) -> dict[str, Any]:
    """Vital-sign time series of a case.

    parameters: any of hr, spo2, rr, sbp, dbp, map, temperature, etco2 (default all).
    interval_minutes: sampling step, 1-60 (default 5). since/until: ISO 8601.
    Canopy keeps the latest 24 hours of each case.
    """
    return await _get(ctx, "get_vitals", f"/cases/{case_id}/vitals",
                      {"parameters": ",".join(parameters) if parameters else None,
                       "interval": max(1, min(interval_minutes, 60)), "since": since, "until": until})


@server.tool(annotations=READ_ONLY)
async def get_case_events(ctx: Context, case_id: str) -> dict[str, Any]:
    """Timeline events of a case (patient in, induction, incision, end of surgery, patient out…)."""
    return await _get(ctx, "get_case_events", f"/cases/{case_id}/events")


@server.tool(annotations=READ_ONLY)
async def get_medications(ctx: Context, case_id: str) -> dict[str, Any]:
    """Drugs, infusions, fluids and outputs of a case, with intake/output totals."""
    return await _get(ctx, "get_medications", f"/cases/{case_id}/medications")


@server.tool(annotations=READ_ONLY)
async def get_case_forms(ctx: Context, case_id: str) -> dict[str, Any]:
    """Clinical form fields of a case (pre-anaesthesia, checklist, PACU, outcome…), as recorded."""
    return await _get(ctx, "get_case_forms", f"/cases/{case_id}/forms")


@server.tool(annotations=READ_ONLY)
async def list_admissions(ctx: Context, ward: str | None = None, status: str | None = None, limit: int = 50) -> dict[str, Any]:
    """Admissions waiting for a bedside Leaf (pending) or already started, by ward. status: pending, started, cancelled, conflict."""
    return await _get(ctx, "list_admissions", "/admissions", {"ward": ward, "status": status, "limit": max(1, min(limit, 200))})


mcp_app = server.streamable_http_app(
    streamable_http_path="/mcp", stateless_http=True, json_response=True,
    # Every request must carry an API key (checked below and again by the Canopy API),
    # and the server sits behind Canopy's TLS edge with its own Host names.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
_valid: dict[str, float] = {}


async def app(scope, receive, send):
    """Health check, and reject requests without a valid Canopy API key before MCP sees them."""
    if scope["type"] == "http" and scope["path"] == "/health":
        await JSONResponse({"status": "ok", "api": API_URL})(scope, receive, send)
        return
    if scope["type"] == "http":
        headers = {key.decode().lower(): value.decode() for key, value in scope.get("headers", [])}
        authorization = headers.get("authorization", "")
        key = authorization[7:].strip() if authorization.lower().startswith("bearer ") else headers.get("x-api-key", "")
        if not key.startswith("flk_"):
            await JSONResponse({"error": "Canopy API key required (Authorization: Bearer flk_…)"}, status_code=401,
                               headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
            return
        if _valid.get(key, 0) < time.monotonic():
            async with httpx.AsyncClient(timeout=10) as client:
                check = await client.get(f"{API_URL}/api/v1/me", headers={"authorization": f"Bearer {key}",
                                                                         "x-flora-client": "mcp",
                                                                         "x-flora-mcp-tool": "connect"})
            if check.status_code != 200:
                await JSONResponse({"error": "invalid, expired or revoked Canopy API key"}, status_code=401,
                                   headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
                return
            _valid[key] = time.monotonic() + 60
    await mcp_app(scope, receive, send)
