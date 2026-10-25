"""leaf-live: the Leaf's live stream service (its own container, no --reload, so sockets survive code edits).

    uvicorn app.live.server:app --host 0.0.0.0 --port 8000

- Gateway side: one GatewayClient per leaf_gateway_link with a stream_url and token.
- Browser side: WS /api/live/ws (docs/live-stream/PROTOCOL.md). First frame {type:"auth", token};
  then subscribe / unsubscribe by case_id; chunks after they are stored; status every 2 s.
"""
import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from ..database import close_pool, open_pool, pool
from ..live_schema import ensure_live_schema
from . import store
from .gateway import GatewayClient
from .rollup import GapTracker, MinuteCloser, browser_chunk

log = logging.getLogger("flora.live")
if not logging.getLogger("flora").handlers:  # uvicorn only configures its own loggers
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    logging.getLogger("flora").addHandler(_handler)
    logging.getLogger("flora").setLevel(logging.INFO)
STATUS_SECONDS = 2
SUPERVISE_SECONDS = float(os.getenv("LEAF_LIVE_RECONCILE_SECONDS", "2"))
AUTH_TIMEOUT_SECONDS = 10
PRUNE_SECONDS = float(os.getenv("LEAF_LIVE_PRUNE_SECONDS", "3600"))
QUEUE_SIZE = 300


class Browser:
    def __init__(self, socket: WebSocket):
        self.socket, self.cases = socket, set()
        self.queue: asyncio.Queue = asyncio.Queue(QUEUE_SIZE)

    def push(self, message: dict) -> None:
        if self.queue.full():  # a stalled browser loses its oldest messages, not the stream
            self.queue.get_nowait()
        self.queue.put_nowait(message)


class Hub:
    def __init__(self):
        self.clients: dict[int, GatewayClient] = {}
        self.gaps: dict[tuple[int, str], GapTracker] = {}
        self.closers: dict[tuple[int, str], MinuteCloser] = {}
        self.known: dict[tuple[int, str], int] = {}  # (case, device) -> gateway link, while bound or binding
        self.browsers: set[Browser] = set()
        self.tasks: list[asyncio.Task] = []

    # ------------------------------------------------------------ stream state
    def track(self, case_id: int, device_id: str, last_stored: int, link_id: int) -> None:
        self.known[(case_id, device_id)] = link_id
        self.gaps.setdefault((case_id, device_id), GapTracker(last_stored))

    def forget(self, case_id: int, device_id: str) -> None:
        self.known.pop((case_id, device_id), None)

    def expect(self, case_id: int, device_id: str, from_seq: Any) -> None:
        """bound.from_seq beyond what we asked for: those seconds are a gap (the minute pull fills them)."""
        tracker = self.gaps.setdefault((case_id, device_id), GapTracker())
        if isinstance(from_seq, int) and tracker.last is not None and from_seq > tracker.last + 1:
            tracker.add(from_seq - 1)

    def closer(self, case_id: int, device_id: str) -> MinuteCloser:
        return self.closers.setdefault((case_id, device_id), MinuteCloser())

    def received(self, case_id: int, device_id: str, chunk: dict) -> None:
        self.gaps.setdefault((case_id, device_id), GapTracker()).add(chunk["seq"])
        message = None
        for browser in self.browsers:
            if case_id in browser.cases:
                message = message or browser_chunk(case_id, chunk)
                browser.push(message)

    def status(self, case_id: int) -> dict:
        now = time.time() * 1000
        devices = []
        for (known_case, device_id), link_id in self.known.items():
            if known_case != case_id:
                continue
            client = self.clients.get(link_id)
            binding = next((b for b in client.bound.values() if b["case_id"] == case_id and b["device_id"] == device_id),
                           None) if client else None
            tracker = self.gaps.get((case_id, device_id)) or GapTracker()
            devices.append({
                "device_id": device_id, "gateway_link_id": link_id, "state": binding["state"] if binding else "pending",
                "connected": bool(client and client.connected and binding and binding["state"] == "bound"),
                "last_seq": tracker.last,
                "lag_ms": round(now - (tracker.last + 1) * 1000) if tracker.last is not None else None,
                "gaps": tracker.gaps})
        return {"type": "status", "case_id": case_id, "devices": devices}

    # ------------------------------------------------------------ background loops
    async def supervise(self) -> None:
        """Start, restart (URL or token changed) and stop one client per streaming gateway link."""
        while True:
            try:
                await asyncio.to_thread(store.release_inactive)
                links = {row["id"]: row for row in await asyncio.to_thread(store.stream_links)}
                for link_id in list(self.clients):
                    if links.get(link_id) != self.clients[link_id].link:
                        await self.clients.pop(link_id).stop()
                for link_id, link in links.items():
                    if link_id not in self.clients:
                        self.clients[link_id] = GatewayClient(self, link)
                        self.clients[link_id].start()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - e.g. before migration 0090; try again
                log.exception("supervisor")
            await asyncio.sleep(SUPERVISE_SECONDS)

    async def broadcast_status(self) -> None:
        while True:
            await asyncio.sleep(STATUS_SECONDS)
            for case_id in {case_id for browser in self.browsers for case_id in browser.cases}:
                message = self.status(case_id)
                for browser in self.browsers:
                    if case_id in browser.cases:
                        browser.push(message)

    async def prune(self) -> None:
        """Hourly retention of stream_wave / stream_second for cases that are not active (store.prune_streams)."""
        while True:
            try:
                deleted = await asyncio.to_thread(store.prune_streams)
                if any(deleted.values()):
                    log.info("stream retention: deleted %s", deleted)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - e.g. before migration 0090; try again next time
                log.exception("stream retention")
            await asyncio.sleep(PRUNE_SECONDS)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self.supervise()), asyncio.create_task(self.broadcast_status()),
                      asyncio.create_task(self.prune())]

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        for client in list(self.clients.values()):
            await client.stop()
        self.clients.clear()


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    await asyncio.to_thread(ensure_live_schema)
    hub.start()
    yield
    await hub.stop()
    close_pool()


app = FastAPI(title="Flora Leaf live", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    with pool.connection() as database:
        database.execute("SELECT 1").fetchone()
    return {"status": "OK", "links": [client.summary() for client in hub.clients.values()],
            "browsers": len(hub.browsers)}


def authenticate(token: str) -> dict:
    from ..routes.auth_leaf import user_for_token
    with pool.connection() as database:
        user = user_for_token(database, token)
    if user.get("must_change_password") or "case.read" not in user.get("_permissions", []):
        raise HTTPException(403, "case.read permission required")
    return user


@app.websocket("/api/live/ws")
async def browser_socket(socket: WebSocket) -> None:
    await socket.accept()
    try:
        first = await asyncio.wait_for(socket.receive_json(), AUTH_TIMEOUT_SECONDS)
        if first.get("type") != "auth":
            raise HTTPException(401, "auth required")
        await asyncio.to_thread(authenticate, str(first.get("token") or ""))
    except (asyncio.TimeoutError, HTTPException, ValueError, KeyError, AttributeError) as error:
        detail = error.detail if isinstance(error, HTTPException) else "auth required"
        await socket.send_json({"type": "error", "code": "unauthorized", "detail": detail})
        await socket.close(4401)
        return
    except WebSocketDisconnect:
        return
    browser = Browser(socket)
    hub.browsers.add(browser)
    sender = asyncio.create_task(send_loop(browser))
    try:
        await socket.send_json({"type": "ready"})
        requested = socket.query_params.get("case_id")
        if requested and requested.isdigit():
            await subscribe(browser, int(requested))
        while True:
            try:
                message = json.loads(await socket.receive_text())
                kind, case_id = message.get("type"), message.get("case_id")
            except (ValueError, AttributeError):
                kind, case_id = None, None
            if not isinstance(case_id, int):
                browser.push({"type": "error", "code": "bad_request", "detail": "case_id required"})
            elif kind == "subscribe":
                await subscribe(browser, case_id)
            elif kind == "unsubscribe":
                browser.cases.discard(case_id)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.browsers.discard(browser)
        sender.cancel()


async def subscribe(browser: Browser, case_id: int) -> None:
    if not await asyncio.to_thread(store.case_exists, case_id):
        browser.push({"type": "error", "code": "not_found", "detail": f"case {case_id} not found"})
        return
    browser.cases.add(case_id)
    browser.push(hub.status(case_id))


async def send_loop(browser: Browser) -> None:
    try:
        while True:
            await browser.socket.send_json(await browser.queue.get())
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - the receive loop sees the closed socket
        pass
