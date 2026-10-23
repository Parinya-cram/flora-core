"""Live stream end-to-end checks on the throwaway Leaf leaf-test-01 (run via demo/test-live-stream.sh).

Gateway admin :7400, stream-hub :7407, leaf-api :7321, leaf-live :7323. Needs `websockets`.
"""
import asyncio, base64, json, subprocess, sys, time, urllib.error, urllib.request

import websockets

GATEWAY, LEAF, LIVE = "http://127.0.0.1:7400", "http://127.0.0.1:7321", "ws://127.0.0.1:7323/api/live/ws"
LEAF_ID, DEVICES = "leaf-test-01", ["m540-sim-1", "m540-sim-2", "m540-sim-3"]
GATEWAY_AUTH = "Basic " + base64.b64encode(b"admin:admin").decode()

def sh(cmd): return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
def call(base, path, body=None, token=None, method=None, auth=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method or ("POST" if body is not None else "GET"))
    req.add_header("content-type", "application/json")
    if token: req.add_header("authorization", f"Bearer {token}")
    if auth: req.add_header("authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except ValueError: return e.code, raw[:300]
def must(status_body, what):
    status, body = status_body
    if status not in (200, 201): raise SystemExit(f"{what} failed: {status} {body}")
    return body
def leaf_sql(sql): return sh(f"docker exec flora-leaf-test-01-leaf-db-1 psql -U flora_admin -d flora -qAtc \"{sql}\"")
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}", flush=True)
gw = lambda path, body=None, method=None: call(GATEWAY, path, body, method=method, auth=GATEWAY_AUTH)

print("== gateway: simulated M540 virtual devices + Leaf token", flush=True)
known = {row["device_id"] for row in must(gw("/api/instances"), "instances")["rows"]}
for n, device in enumerate(DEVICES, start=1):
    fields = {"device_type": "draeger-iacs-m540", "pod": "socket.m540-relay", "label": f"Simulated Dräger M540 #{n}",
              "enabled": True, "options": {"source_ip": f"10.20.0.{10 + n}", "wave_channels": {"1-1": "ecg", "25-1": "pleth"}}}
    if device in known: must(gw(f"/api/instances/{device}", fields, "PUT"), f"update {device}")
    else: must(gw("/api/instances", {"device_id": device, **fields}), f"create {device}")
must(gw("/api/instances/reconcile", {}), "reconcile")
token = must(gw("/api/leaf-tokens", {"leaf_id": LEAF_ID, "label": "live stream e2e"}), "leaf token")
deadline = time.time() + 90
while time.time() < deadline and "Up" not in sh("docker ps --filter name=flora-gw-parser-pod --format '{{.Status}}'"):
    time.sleep(2)
check("one pod parser container serves all M540s", sh("docker ps --filter name=flora-gw-parser-pod -q | wc -l").strip() == "1"
      and not sh("docker ps --filter name=flora-gw-parser-m540-sim -q"))

print("== leaf: gateway link + three active cases", flush=True)
session = must(call(LEAF, "/api/auth/login", {"username": "admin", "password": "admin"}), "login")["session_token"]
link = must(call(LEAF, "/api/ward/gateway/links", {
    "gateway_id": "gateway-hospital-01-a", "label": "Gateway (e2e)", "is_default": True,
    "data_api_url": "http://host.docker.internal:7410/data-api",
    "stream_url": "ws://host.docker.internal:7407/stream/v1", "token": token["token"]}, session), "link")["link"]
now = lambda: int(time.time() * 1000)
def start(bed, devices):
    return call(LEAF, "/api/case/start", {"start_time": now(), "admission_source": "manual", "hn": f"LIVE-{bed}-{int(time.time())}",
                "patient_name": f"Live test {bed}", "bed_label": bed, "overlap_policy": "exclude",
                "devices": [{"gateway_link_id": link["id"], "device_id": d, "mode": m} for d, m in devices]}, session)
a = must(start("R1", [("m540-sim-1", "exclusive")]), "start A")
b = must(start("R2", [("m540-sim-2", "exclusive"), ("m540-sim-3", "shared")]), "start B")
c = must(start("R3", [("m540-sim-3", "shared")]), "start C")
clash = start("R4", [("m540-sim-1", "exclusive")])
check("exclusive clash is refused", clash[0] == 409 and isinstance(clash[1], dict) and clash[1].get("error") == "device_in_use", str(clash))
clash = start("R4", [("m540-sim-3", "exclusive")])
check("exclusive on a shared device is refused", clash[0] == 409, str(clash[0]))
active = must(call(LEAF, "/api/case/active", token=session), "active")["cases"]
check("three active cases on one Leaf", len(active) == 3, str([c["bed_label"] for c in active]))
uuids = {row["case_id"]: row["case_uuid"] for row in active}
a_id, b_id, c_id = a["case_id"], b["case_id"], c["case_id"]

print("== gateway audit: case UUIDs bound", flush=True)
deadline, bound = time.time() + 30, []
while time.time() < deadline:
    bound = must(gw(f"/api/case-bindings?open=1&leaf_id={LEAF_ID}"), "bindings")["rows"]
    if len(bound) >= 4: break
    time.sleep(2)
pairs = {(row["case_uuid"], row["device_id"], row["mode"]) for row in bound}
expected = {(uuids[a_id], "m540-sim-1", "exclusive"), (uuids[b_id], "m540-sim-2", "exclusive"),
            (uuids[b_id], "m540-sim-3", "shared"), (uuids[c_id], "m540-sim-3", "shared")}
check("gateway records every case UUID ↔ device binding", expected <= pairs, f"{len(pairs)} open")

async def browser(case_id, seconds):
    chunks = []
    async with websockets.connect(LIVE) as ws:
        await ws.send(json.dumps({"type": "auth", "token": session}))
        await ws.send(json.dumps({"type": "subscribe", "case_id": case_id}))
        end = time.time() + seconds
        while time.time() < end:
            try: msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
            except asyncio.TimeoutError: break
            if msg["type"] == "chunk": chunks.append((time.time() * 1000, msg))
    return chunks

print("== browser stream for case A (up to 90 s)", flush=True)
# A case starts on the quarter hour, so leaf-live first replays that backlog; judge the 20 s after catch-up.
chunks = asyncio.run(browser(a_id, 90))
caught_up = next((i for i, (arrived, m) in enumerate(chunks) if arrived - (m["t0"] + 1000) < 2000), len(chunks))
live = chunks[caught_up:caught_up + 20]
if 0 < caught_up < len(chunks):
    took = (chunks[caught_up][0] - chunks[0][0]) / 1000
    print(f"catch-up: {caught_up} replayed chunks in {took:.1f} s ({caught_up / max(took, 0.001):.0f} chunks/s)", flush=True)
late = sorted(arrived - (m["t0"] + 1000) for arrived, m in live)
p95 = late[max(0, int(len(late) * 0.95) - 1)] if late else None
check("browser receives one chunk per second", len(live) >= 17 and live[-1][1]["seq"] - live[0][1]["seq"] == len(live) - 1, f"{len(live)} live chunks after {caught_up} replayed")
check("chunk reaches browser ≤ 1.5 s after its window closes (p95)", p95 is not None and p95 <= 1500, f"p95={p95:.0f} ms" if p95 is not None else "")
check("only case A's device reaches case A", {m["device_id"] for _, m in chunks} == {"m540-sim-1"})
ecg = sorted(sum(len(w["samples"]) for w in m.get("waves", []) if w["channel"] == "ecg") for _, m in live)
median = ecg[len(ecg) // 2] if ecg else 0
check("ECG waveform ≈ 200 samples per second (median)", 160 <= median <= 240, f"median {median}/s")
check("numerics mapped for the chart", any(m["numerics"].get("hr") is not None for _, m in live))

print("== stream-hub outage 60 s, then resume", flush=True)
first = int(leaf_sql(f"SELECT min(seq) FROM stream_second WHERE case_id={a_id}") or 0)
sh("docker stop flora-gateway-stream-hub-1"); time.sleep(60); sh("docker start flora-gateway-stream-hub-1")
time.sleep(40)
row = leaf_sql(f"SELECT max(seq), count(*) FROM stream_second WHERE case_id={a_id} AND seq >= {first}").split("|")
last, count = int(row[0]), int(row[1])
check("case A seconds are contiguous across the outage", count == last - first + 1, f"{count} rows for {last - first + 1} seconds")
shared = leaf_sql(f"SELECT count(*) FROM stream_second s JOIN stream_second t ON t.seq=s.seq AND t.device_id=s.device_id "
                  f"WHERE s.case_id={b_id} AND t.case_id={c_id} AND s.device_id='m540-sim-3'")
check("shared device fans out to both cases", int(shared or 0) > 30, f"{shared} common seconds")
minutes = leaf_sql(f"SELECT count(*) FROM vital_minutes WHERE case_id={a_id} AND ivy_source='vector'")
check("closed minutes rolled into the chart", int(minutes or 0) >= 1, f"{minutes} minutes")

print("== discharge A releases its binding at the gateway", flush=True)
must(call(LEAF, "/api/case/discharge", {"case_id": a_id}, session), "discharge A")
deadline, closed = time.time() + 20, []
while time.time() < deadline:
    closed = [r for r in must(gw(f"/api/case-bindings?case_uuid={uuids[a_id]}"), "bindings")["rows"] if r["unbound_at"]]
    if any(r["unbind_reason"] in ("discharged", "case_inactive") for r in closed): break
    time.sleep(2)
check("gateway closes case A binding on discharge", any(r["unbind_reason"] in ("discharged", "case_inactive") for r in closed),
      str({r["unbind_reason"] for r in closed}))
must(call(LEAF, "/api/case/discharge", {"case_id": b_id}, session), "discharge B")
must(call(LEAF, "/api/case/discharge", {"case_id": c_id}, session), "discharge C")
must(gw(f"/api/leaf-tokens/{token['id']}/revoke", {}), "revoke token")

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
