"""Live-stream links without hand work (docs/live-stream/PROTOCOL.md).

After each ward exchange the Leaf makes sure it has a gateway link, with a stream URL and a token, for every
gateway that carries its devices (devices assigned to this Leaf, or placed at one of its beds in Canopy):

- a missing link is created from the gateway's data-api URL (Canopy's gateway list);
- a link without a stream URL gets one derived from the data-api URL (stream-hub: port 7407 or /stream/ on the edge);
- a link without a token gets a new one: the Leaf registers its sha256 with the appliance, which hands it to every
  gateway on their next check-in. The token itself never leaves this Leaf.

Links set by hand (gateway wizard, Manage gateways) are left as they are. Best effort: a failure waits for the next
exchange.
"""
import hashlib
import json
import logging
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from psycopg import Connection

log = logging.getLogger("flora.stream_links")
LEAF_ID = os.getenv("FLORA_LEAF_ID", "").strip()
HABER_URL = os.getenv("FLORA_HABER_URL", "").strip().rstrip("/")
NODE_TOKEN = os.getenv("HABER_NODE_TOKEN", "").strip()
DATA_API_PORT, STREAM_PORT = 7410, 7407


def stream_url_for(data_api_url: str | None) -> str | None:
    """ws://host:7407/stream/v1 for a data-api on its own port (Kong :7410), wss://host[:port]/stream/v1 through the
    gateway's HTTPS edge."""
    if not data_api_url:
        return None
    url = urllib.parse.urlparse(data_api_url)
    if not url.hostname:
        return None
    if url.scheme == "https":
        port = f":{url.port}" if url.port and url.port != 443 else ""
        return f"wss://{url.hostname}{port}/stream/v1"
    port = STREAM_PORT if url.port in (None, DATA_API_PORT) else url.port
    return f"ws://{url.hostname}:{port}/stream/v1"


def my_gateways(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Gateways (from the ward exchange) that carry a device of this Leaf or of one of its beds."""
    at_beds = {device.get("gateway_id") for bed in payload.get("my_beds") or [] for device in bed.get("devices") or []}
    return [gateway for gateway in payload.get("gateways") or []
            if gateway.get("data_api_url") and (gateway.get("gateway_id") in at_beds or any(
                device.get("leaf_id") == LEAF_ID for device in gateway.get("devices") or []))]


def register(token: str) -> bool:
    request = urllib.request.Request(
        f"{HABER_URL}/api/haber/v1/nodes/{urllib.parse.quote(LEAF_ID)}/stream-token", method="POST",
        data=json.dumps({"token_hash": hashlib.sha256(token.encode()).hexdigest()}).encode(),
        headers={"Authorization": f"Bearer {NODE_TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5):
            return True
    except (urllib.error.URLError, OSError) as error:
        log.warning("stream token not registered with the appliance: %s", error)
        return False


def ensure(database: Connection, payload: dict[str, Any], now: int) -> list[str]:
    """Create / complete this Leaf's gateway links; returns what changed (for the log)."""
    if not LEAF_ID:
        return []
    changed: list[str] = []
    for gateway in my_gateways(payload):
        gateway_id, data_api_url = gateway["gateway_id"], gateway["data_api_url"]
        link = database.execute("SELECT * FROM leaf_gateway_link WHERE gateway_id=%s ORDER BY id LIMIT 1",
                                (gateway_id,)).fetchone()
        if link is None:
            first = database.execute("SELECT 1 FROM leaf_gateway_link WHERE is_default").fetchone() is None
            link = database.execute(
                """INSERT INTO leaf_gateway_link (gateway_id, label, data_api_url, stream_url, is_default, created_at, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (gateway_id, gateway.get("site_name") or gateway_id, data_api_url, stream_url_for(data_api_url), first,
                 now, now)).fetchone()
            changed.append(f"link {gateway_id} added")
        elif not link.get("stream_url"):
            database.execute("UPDATE leaf_gateway_link SET stream_url=%s, updated_at=%s WHERE id=%s",
                             (stream_url_for(link.get("data_api_url") or data_api_url), now, link["id"]))
            changed.append(f"link {gateway_id} stream URL")
        if not link.get("token") and HABER_URL and NODE_TOKEN:
            token = secrets.token_urlsafe(32)
            if register(token):
                database.execute("UPDATE leaf_gateway_link SET token=%s, updated_at=%s WHERE id=%s", (token, now, link["id"]))
                changed.append(f"link {gateway_id} token")
    return changed
