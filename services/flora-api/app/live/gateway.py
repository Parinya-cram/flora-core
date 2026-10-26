"""One WebSocket per gateway link to the Gateway stream-hub (docs/live-stream/PROTOCOL.md).

Binds the devices of every active case on the link, stores chunks, acks them, then hands them
to the browser fan-out. Chunks already queued from the socket are handled together: one
transaction, one cumulative ack per device (fast catch-up of a replayed backlog). Reconnects
with backoff; bindings are reconciled with the database every RECONCILE_SECONDS.
"""
import asyncio
import json
import logging
import os
import random
import time
from typing import Any

from websockets.asyncio.client import connect

from ..case_bindings import LEAF_ID
from . import store

log = logging.getLogger("flora.live.gateway")
RECONCILE_SECONDS = float(os.getenv("LEAF_LIVE_RECONCILE_SECONDS", "2"))
REJECTED_RETRY_SECONDS = 30
BATCH_MAX = max(1, int(os.getenv("LEAF_LIVE_BATCH_MAX", "2000")))  # messages handled per transaction


class GatewayClient:
    def __init__(self, hub, link: dict[str, Any]):
        self.hub, self.link = hub, link
        self.connected, self.session_id, self.devices, self.last_error = False, None, [], None
        self.connected_at = None
        self.bound: dict[str, dict[str, Any]] = {}  # binding_id -> target + gateway state
        self.acked: dict[str, int] = {}
        self.task: asyncio.Task | None = None

    @property
    def link_id(self) -> int:
        return self.link["id"]

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name=f"gateway-link-{self.link_id}")

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass

    def summary(self) -> dict[str, Any]:
        return {"link_id": self.link_id, "stream_url": self.link["stream_url"], "connected": self.connected,
                "session_id": self.session_id, "bound": sum(1 for b in self.bound.values() if b["state"] == "bound"),
                "pending": sum(1 for b in self.bound.values() if b["state"] == "pending"),
                "rejected": sum(1 for b in self.bound.values() if b["state"] == "rejected"),
                "last_error": self.last_error}

    async def run(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self.session()
                backoff = 1.0
            except asyncio.CancelledError:
                await self.disconnected("leaf-live stopped")
                raise
            except Exception as error:  # noqa: BLE001 - any failure: reconnect
                self.last_error = f"{type(error).__name__}: {error}"
                log.warning("gateway link %s: %s", self.link_id, self.last_error)
            await self.disconnected(self.last_error or "closed")
            await asyncio.sleep(backoff + random.random())
            backoff = min(backoff * 2, 30)

    async def session(self) -> None:
        async with connect(self.link["stream_url"], open_timeout=10, ping_interval=20, ping_timeout=20,
                           max_size=16 * 2**20) as socket:
            await socket.send(json.dumps({"type": "hello", "leaf_id": LEAF_ID, "token": self.link["token"], "proto": 1}))
            welcome = json.loads(await asyncio.wait_for(socket.recv(), 10))
            if welcome.get("type") != "welcome":
                raise ConnectionError(f"{welcome.get('code') or welcome.get('type')}: {welcome.get('detail') or ''}")
            self.connected, self.connected_at = True, time.time()
            self.session_id, self.devices, self.last_error = welcome.get("session_id"), welcome.get("devices") or [], None
            log.info("gateway link %s connected (session %s)", self.link_id, self.session_id)
            reconciler = asyncio.create_task(self.reconcile_loop(socket))
            inbox: asyncio.Queue = asyncio.Queue()  # bounded by the hub's max_unacked per device
            reader = asyncio.create_task(self.read(socket, inbox))
            try:
                while True:
                    batch = [await inbox.get()]
                    while len(batch) < BATCH_MAX and not inbox.empty():
                        batch.append(inbox.get_nowait())
                    if not await self.handle_batch(socket, batch):
                        return
            finally:
                reconciler.cancel()
                reader.cancel()

    @staticmethod
    async def read(socket, inbox: asyncio.Queue) -> None:
        """Socket -> inbox, so chunks pile up while a batch is being stored. Ends with None or the error."""
        try:
            async for message in socket:
                inbox.put_nowait(json.loads(message))
            inbox.put_nowait(None)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - re-raised by the session loop
            inbox.put_nowait(error)

    async def handle_batch(self, socket, batch: list) -> bool:
        """Messages in arrival order; runs of chunks are stored together. False when the socket closed."""
        chunks: list[dict[str, Any]] = []
        for message in batch:
            if isinstance(message, dict) and message.get("type") == "chunk":
                chunks.append(message)
                continue
            if chunks:
                await self.chunks(socket, chunks)
                chunks = []
            if message is None:
                return False
            if isinstance(message, Exception):
                raise message
            await self.handle(socket, message)
        if chunks:
            await self.chunks(socket, chunks)
        return True

    async def disconnected(self, reason: str) -> None:
        was_bound = [binding_id for binding_id, b in self.bound.items() if b["state"] != "rejected"]
        self.connected, self.session_id, self.bound, self.acked = False, None, {}, {}
        try:
            await asyncio.to_thread(store.set_state, was_bound, "pending", f"gateway disconnected: {reason}"[:300])
        except Exception:  # noqa: BLE001
            log.exception("could not mark bindings pending")

    async def reconcile_loop(self, socket) -> None:
        while True:
            try:
                await self.reconcile(socket)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the socket loop decides about reconnecting
                log.exception("gateway link %s: reconcile failed", self.link_id)
            await asyncio.sleep(RECONCILE_SECONDS)

    async def reconcile(self, socket) -> None:
        wanted = {row["binding_id"]: row for row in await asyncio.to_thread(store.targets, self.link_id)}
        gone = [binding_id for binding_id in self.bound if binding_id not in wanted]
        reasons = await asyncio.to_thread(store.release_reasons, gone)
        for binding_id in gone:
            binding = self.bound.pop(binding_id)
            self.hub.forget(binding["case_id"], binding["device_id"])
            await socket.send(json.dumps({"type": "unbind", "case_uuid": binding["case_uuid"], "device_id": binding["device_id"],
                                          "reason": reasons.get(binding_id, "case_inactive")}))
        now = time.time()
        for binding_id, target in wanted.items():
            current = self.bound.get(binding_id)
            if current and not (current["state"] == "rejected" and now - current["changed"] > REJECTED_RETRY_SECONDS):
                continue
            # Keep the in-memory stream state of a retried binding.
            self.bound[binding_id] = {**target, "state": "pending", "changed": now}
            self.hub.track(target["case_id"], target["device_id"], target["resume_seq"] - 1, self.link_id)
            await socket.send(json.dumps({"type": "bind", "case_uuid": target["case_uuid"], "device_id": target["device_id"],
                                          "mode": target["mode"], "resume_seq": target["resume_seq"]}))

    def find(self, case_uuid: str, device_id: str) -> tuple[str, dict] | tuple[None, None]:
        for binding_id, binding in self.bound.items():
            if binding["case_uuid"] == case_uuid and binding["device_id"] == device_id:
                return binding_id, binding
        return None, None

    async def handle(self, socket, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "chunk":
            await self.chunks(socket, [message])
        elif kind in ("bound", "rejected"):
            binding_id, binding = self.find(message.get("case_uuid"), message.get("device_id"))
            if binding is None:
                return
            binding.update(state=kind, changed=time.time())
            if kind == "bound":
                detail = f"from_seq {message.get('from_seq')}"
                self.hub.expect(binding["case_id"], binding["device_id"], message.get("from_seq"))
            else:
                detail = f"{message.get('code')}: {message.get('detail') or ''}".strip()
            await asyncio.to_thread(store.set_state, [binding_id], kind, detail)
        elif kind == "error":
            self.last_error = f"{message.get('code')}: {message.get('detail') or ''}"
            log.warning("gateway link %s error %s", self.link_id, self.last_error)
        elif kind == "welcome":
            self.devices = message.get("devices") or []

    async def chunks(self, socket, chunks: list[dict[str, Any]]) -> None:
        """Store every chunk for the cases bound to its device (one transaction), ack each device once, fan out."""
        work, acks = [], {}
        for chunk in chunks:
            device_id, seq = chunk.get("device_id"), chunk.get("seq")
            if device_id is None or not isinstance(seq, int):
                continue
            # A case only keeps seconds from its own start (another case may have asked for an earlier replay).
            cases = sorted({binding["case_id"] for binding in self.bound.values()
                            if binding["device_id"] == device_id and binding["state"] != "rejected"
                            and seq >= binding["origin_seq"]})
            if cases:
                work.append((chunk, [(case_id, self.hub.closer(case_id, device_id).add(seq)) for case_id in cases]))
            acks[device_id] = max(acks.get(device_id, seq), seq)
        if work:
            try:
                await asyncio.to_thread(store.store_chunks, work)
            except Exception:
                # Not acked: the hub resends from here after the reconnect; roll these minutes then.
                for chunk, closing in work:
                    for case_id, minutes in closing:
                        self.hub.closer(case_id, chunk["device_id"]).dirty.update(minutes)
                raise
        for device_id, seq in acks.items():  # cumulative (PROTOCOL.md)
            ack = max(self.acked.get(device_id, seq), seq)
            self.acked[device_id] = ack
            await socket.send(json.dumps({"type": "ack", "device_id": device_id, "seq": ack}))
        for chunk, closing in work:
            for case_id, _ in closing:
                self.hub.received(case_id, chunk["device_id"], chunk)
