"""Administrator → Logs: the Canopy activity log plus the Leaf user-directory audit, newest first."""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection

from ..database import connection
from .canopy_preferences import current_canopy_user

router = APIRouter(prefix="/api/fleet/activity", tags=["activity log"])

ADMIN_PERMISSIONS = {"account.manage", "config.manage"}

# One row shape for both sources; auth_audit rows are user changes made on (or synced from) Leafs.
ROWS = """
  SELECT 'canopy' AS source, id, at, user_id, username, user_name, role, category, action, method, path, query,
         status, ok, duration_ms, ip, user_agent, detail
  FROM canopy_activity_log
  UNION ALL
  SELECT 'directory', id, created_at, actor_user_id, actor_username, NULL, actor_role, 'users',
         action || coalesce(' · ' || target_username, ''), NULL, NULL, NULL, NULL, coalesce(status, 'ok') = 'ok', NULL, NULL, NULL,
         CASE WHEN detail_json ~ '^\\s*\\{' THEN detail_json::jsonb END
  FROM auth_audit
"""


def require_log_viewer(user: dict[str, Any] = Depends(current_canopy_user)) -> dict[str, Any]:
    admin = str(user.get("role") or "").lower() in {"admin", "system_admin"}
    if not admin and not ADMIN_PERMISSIONS & set(user.get("_permissions") or []):
        raise HTTPException(status_code=403, detail="Canopy administrator access required")
    return user


@router.get("")
def activity(
    start: int | None = Query(default=None, alias="from"),
    end: int | None = Query(default=None, alias="to"),
    q: str | None = None,
    category: str | None = None,
    outcome: str | None = Query(default=None, pattern="^(ok|failed)$"),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _: dict[str, Any] = Depends(require_log_viewer),
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    where, params = [], []
    if start is not None:
        where.append("at >= %s"); params.append(start)
    if end is not None:
        where.append("at < %s"); params.append(end)
    if q and q.strip():
        like = f"%{q.strip()}%"
        where.append("(username ILIKE %s OR user_name ILIKE %s OR action ILIKE %s OR ip ILIKE %s)"); params += [like, like, like, like]
    if outcome:
        where.append("ok = %s"); params.append(outcome == "ok")
    filtered = f"SELECT * FROM ({ROWS}) a" + (f" WHERE {' AND '.join(where)}" if where else "")
    # Statistics follow every filter except the category, so its chips still show all categories.
    stats = database.execute(
        f"""SELECT count(*) AS total, count(*) FILTER (WHERE NOT ok) AS failed,
                   count(DISTINCT lower(username)) AS users,
                   count(*) FILTER (WHERE action='sign in') AS sign_ins,
                   count(*) FILTER (WHERE action='sign in failed') AS failed_sign_ins
            FROM ({filtered}) f""", params).fetchone()
    categories = database.execute(
        f"SELECT category, count(*) AS count FROM ({filtered}) f GROUP BY category ORDER BY count DESC", params).fetchall()
    rows_sql, rows_params = filtered, list(params)
    if category:
        rows_sql = f"SELECT * FROM ({filtered}) f WHERE category = %s"; rows_params.append(category)
    total = database.execute(f"SELECT count(*) AS n FROM ({rows_sql}) r", rows_params).fetchone()["n"]
    rows = database.execute(f"{rows_sql} ORDER BY at DESC, id DESC LIMIT %s OFFSET %s", [*rows_params, limit, offset]).fetchall()
    return {"rows": [dict(row) for row in rows], "total": total, "stats": dict(stats), "categories": [dict(row) for row in categories]}
