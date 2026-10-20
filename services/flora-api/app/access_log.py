"""Quieter access logs. Docker keeps container logs (capped by compose), and nearly all of a Flora API's lines were
requests repeated every few seconds: the sync worker reads 16 endpoints for every open case each 10 s cycle and sends
its batches, the screens poll (ward, reading jobs, health). What is written now:
- every error (4xx, 5xx), whatever the request;
- every write (POST, PUT, PATCH, DELETE), except the sync worker's cycle (it prints its own line when something
  changes);
- no successful read (GET, HEAD).
FLORA_ACCESS_LOG_ALL=true writes every request again (debugging)."""
from __future__ import annotations

import logging
import os
import re

QUIET_WRITES = re.compile(
    r"^(PUT|POST) (/api/ward/(sync-status|state)\b|/api/leaf-sync/|/api/case/(workflow-forms-sync|canopy-sync)/inbox\b"
    r"|/api/case/staff/sync/apply\b|/api/auth/directory\b|/api/case-documents/\d+/synced\b|/api/sync/v1/)")


class PollFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        # uvicorn.access: (client, method, path, http version, status)
        if not isinstance(args, tuple) or len(args) < 5:
            return True
        method, path, status = str(args[1]), str(args[2]), args[4]
        if isinstance(status, int) and status >= 400:
            return True
        if method in ("GET", "HEAD", "OPTIONS"):
            return False
        return not QUIET_WRITES.match(f"{method} {path}")


def install() -> None:
    if os.getenv("FLORA_ACCESS_LOG_ALL", "").lower() in ("1", "true", "yes"):
        return
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, PollFilter) for item in logger.filters):
        logger.addFilter(PollFilter())
