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


# Cloudflare and similar front doors reject Python's default "Python-urllib" agent with a 403
# (Cloudflare error 1010), which looked exactly like a rejected key.
USER_AGENT = "ESM-Flora/1.0"


class FirewallBlocked(Exception):
    pass


def openai_bases(host: str) -> list[str]:
    """Where the OpenAI-compatible API may live: the host as typed (OpenRouter .../api/v1, Open WebUI .../api)
    first, then host + /v1 (Ollama, vLLM and LM Studio are usually entered without it)."""
    host = host.rstrip("/")
    return [host] if host.endswith("/v1") else [host, f"{host}/v1"]


def _openai_models(config: dict[str, Any]) -> list[str]:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if config.get("api_key"):
        headers["Authorization"] = f"Bearer {config['api_key']}"
    last: Exception | None = None
    for base in openai_bases(config.get("host") or ""):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{base}/models", headers=headers), timeout=10) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in {401, 403}:
                body = error.read(300).decode("utf-8", "replace")
                cloudflare = "cloudflare" in (error.headers.get("server") or "").lower()
                if error.code == 403 and ("error code: 10" in body or (cloudflare and "detail" not in body)):
                    raise FirewallBlocked(body.strip()[:80]) from error
                raise
            last = error  # 404 / 405: not this base, try the next
            continue
        except ValueError as error:  # not JSON (e.g. a web page at this path)
            last = error
            continue
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            return [str(item.get("id")) for item in payload["data"] if isinstance(item, dict)]
        last = ValueError("not an OpenAI model list")
    raise last or ValueError("no OpenAI-compatible model list found")


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
    except FirewallBlocked as error:
        return {"ok": False, "error": f"the host's firewall blocked the request before it reached the API ({error})"}
    except urllib.error.HTTPError as error:
        return {"ok": False, "error": "API key was rejected" if error.code in {401, 403} else f"service error {error.code}"}
    except ValueError:
        # The host answered, but not with an OpenAI model list (a web page, or the wrong path).
        return {"ok": False, "error": "the host answered but no OpenAI-compatible API was found there; check the path (e.g. …/api or …/v1)"}
    except OSError as error:
        return {"ok": False, "error": f"cannot reach the service host ({type(error).__name__})"}


class AiServiceError(Exception):
    """A chat call failed; the message is safe to show to users."""


def _strip_thinking(text: str) -> str:
    # Reasoning models (Qwen3, DeepSeek R1...) may return their thinking inline.
    import re
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.S).strip()


def complete(config: dict[str, Any], system: str, messages: list[dict[str, str]], *, max_tokens: int = 6000,
             timeout: float = 180.0) -> str:
    """One chat turn on the configured service. messages: [{role: user|assistant, content}]."""
    model = (config.get("model") or "").strip()
    if not model:
        raise AiServiceError("The AI service is not configured (Account → AI service).")
    if config.get("api_format") == "openai":
        if not config.get("host"):
            raise AiServiceError("The AI service host is not configured.")
        body = json.dumps({"model": model, "max_tokens": max_tokens, "temperature": 0.2,
                           "messages": [{"role": "system", "content": system}, *messages]}).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT}
        if config.get("api_key"):
            headers["Authorization"] = f"Bearer {config['api_key']}"
        for base in openai_bases(config["host"]):
            request = urllib.request.Request(f"{base}/chat/completions", data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    payload = json.load(response)
            except urllib.error.HTTPError as error:
                if error.code in {404, 405}:
                    continue
                if error.code in {401, 403}:
                    raise AiServiceError("The AI service rejected the request (check the API key).") from error
                raise AiServiceError(f"The AI service returned an error ({error.code}).") from error
            except (OSError, ValueError) as error:
                raise AiServiceError(f"Cannot reach the AI service ({type(error).__name__}).") from error
            choice = (payload.get("choices") or [{}])[0]
            return _strip_thinking(str((choice.get("message") or {}).get("content") or ""))
        raise AiServiceError("No chat endpoint found at the AI service host.")
    import anthropic

    try:
        reply = anthropic_client(config, timeout=timeout).messages.create(
            model=model, system=system, messages=messages, max_tokens=max_tokens, temperature=0.2)
    except anthropic.AuthenticationError as error:
        raise AiServiceError("The AI service rejected the API key.") from error
    except anthropic.APIStatusError as error:
        raise AiServiceError(f"The AI service returned an error ({error.status_code}).") from error
    except anthropic.APIConnectionError as error:
        raise AiServiceError("Cannot reach the AI service.") from error
    return _strip_thinking("".join(block.text for block in reply.content if getattr(block, "type", "") == "text"))
