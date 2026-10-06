"""Browser sign-in (HTTP Basic) for the admin page and API.

Machine-to-machine endpoints listed in `public` keep their own key/token auth.
Credentials come from env; the demo default is admin / admin.
"""
import base64
import hmac
import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import Response


def install(app: FastAPI, realm: str, env_prefix: str, public: list[str]) -> None:
    username = os.getenv(f"{env_prefix}_ADMIN_USERNAME", "admin")
    password = os.getenv(f"{env_prefix}_ADMIN_PASSWORD", "admin")
    patterns = [re.compile(pattern) for pattern in public]

    @app.middleware("http")
    async def basic_auth(request: Request, call_next):
        if any(pattern.fullmatch(request.url.path) for pattern in patterns):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                user, _, secret = base64.b64decode(header[6:]).decode().partition(":")
            except (ValueError, UnicodeDecodeError):
                user, secret = "", ""
            if hmac.compare_digest(user, username) and hmac.compare_digest(secret, password):
                return await call_next(request)
        return Response(status_code=401, headers={"WWW-Authenticate": f'Basic realm="{realm}"'})
