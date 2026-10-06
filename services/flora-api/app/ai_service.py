"""The AI / LLM service shared by every Flora feature (host, key, model).

Canopy owns the configuration; Leafs keep the copy they receive with the
directory sync. Features call `anthropic_client()` (Anthropic format) or read
`load()` for an OpenAI-compatible endpoint. The key is never sent to browsers.
"""
import json
import time
import urllib.error
import urllib.request
from typing import Any

from psycopg import Connection

FORMATS = {"anthropic", "openai"}


def load(database: Connection) -> dict[str, Any]:
    row = database.execute("SELECT * FROM ai_service_config WHERE id=1").fetchone()
    return dict(row) if row else {"api_format": "anthropic", "host": "", "api_key": "", "model": "",
                                  "version": 0, "updated_at": 0, "updated_by": None}


def public(config: dict[str, Any]) -> dict[str, Any]:
    key = config.get("api_key") or ""
    return {
        "apiFormat": config.get("api_format") or "anthropic",
        "host": config.get("host") or "",
        "model": config.get("model") or "",
        "hasKey": bool(key),
        "keyHint": f"…{key[-4:]}" if len(key) >= 8 else ("set" if key else ""),
        "version": config.get("version") or 0,
        "updatedAt": config.get("updated_at") or 0,
        "updatedBy": config.get("updated_by"),
        "configured": bool(config.get("model")) and (bool(config.get("host")) or config.get("api_format") == "anthropic"),
    }


def save(database: Connection, *, api_format: str, host: str, model: str, api_key: str | None, actor: str | None,
         version: int | None = None) -> dict[str, Any]:
    """api_key None keeps the stored key; an empty string clears it."""
    current = load(database)
    stamp = version or int(time.time() * 1000)
    database.execute(
        """INSERT INTO ai_service_config(id,api_format,host,api_key,model,version,updated_at,updated_by)
           VALUES (1,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT(id) DO UPDATE SET api_format=excluded.api_format,host=excluded.host,api_key=excluded.api_key,
             model=excluded.model,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
        (api_format, host.strip().rstrip("/"), current.get("api_key") or "" if api_key is None else api_key.strip(),
         model.strip(), stamp, stamp, actor),
    )
    return load(database)


def anthropic_client(config: dict[str, Any], timeout: float = 60.0):
    """Official Anthropic SDK client for the configured host (empty host = Anthropic API)."""
    import anthropic

    options: dict[str, Any] = {"api_key": config.get("api_key") or None, "timeout": timeout, "max_retries": 1}
    if config.get("host"):
        options["base_url"] = config["host"]
    return anthropic.Anthropic(**options)


def _openai_models(config: dict[str, Any]) -> list[str]:
    host = (config.get("host") or "").rstrip("/")
    base = host if host.endswith("/v1") else f"{host}/v1"
    headers = {"Accept": "application/json"}
    if config.get("api_key"):
        headers["Authorization"] = f"Bearer {config['api_key']}"
    with urllib.request.urlopen(urllib.request.Request(f"{base}/models", headers=headers), timeout=10) as response:
        payload = json.load(response)
    return [str(item.get("id")) for item in payload.get("data") or [] if isinstance(item, dict)]


def test(config: dict[str, Any]) -> dict[str, Any]:
    """Check host, key and model without generating tokens (a model lookup only)."""
    started = time.monotonic()
    model = (config.get("model") or "").strip()
    if not model:
        return {"ok": False, "error": "model is required"}
    try:
        if config.get("api_format") == "openai":
            if not config.get("host"):
                return {"ok": False, "error": "host is required for an OpenAI-compatible service"}
            models = _openai_models(config)
            if model not in models:
                return {"ok": False, "error": f"model {model} not offered by the service",
                        "models": models[:50], "latencyMs": int((time.monotonic() - started) * 1000)}
            return {"ok": True, "model": model, "latencyMs": int((time.monotonic() - started) * 1000)}
        import anthropic

        client = anthropic_client(config, timeout=15.0)
        try:
            info = client.models.retrieve(model)
        except anthropic.NotFoundError:
            return {"ok": False, "error": f"model {model} not found on this service",
                    "latencyMs": int((time.monotonic() - started) * 1000)}
        except anthropic.AuthenticationError:
            return {"ok": False, "error": "API key was rejected"}
        except anthropic.PermissionDeniedError:
            return {"ok": False, "error": "API key lacks permission for this model"}
        except anthropic.APIStatusError as error:
            return {"ok": False, "error": f"service error {error.status_code}"}
        except anthropic.APIConnectionError:
            return {"ok": False, "error": "cannot reach the service host"}
        return {"ok": True, "model": info.id, "displayName": getattr(info, "display_name", None),
                "latencyMs": int((time.monotonic() - started) * 1000)}
    except urllib.error.HTTPError as error:
        return {"ok": False, "error": "API key was rejected" if error.code in {401, 403} else f"service error {error.code}"}
    except (OSError, ValueError) as error:
        return {"ok": False, "error": f"cannot reach the service host ({type(error).__name__})"}
