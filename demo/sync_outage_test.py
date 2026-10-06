"""Offline → reconnect sync correctness test on a throwaway Leaf (leaf-test-01, ports 7320-7322).

Run through demo/test-sync-outage.sh, which creates and removes that Leaf. Never touches the demo Leaves.
"""
import json, subprocess, sys, time, urllib.request, urllib.error

LEAF, LEAF_ID = "http://127.0.0.1:7321", "leaf-test-01"
RESTART_WORKER_OFFLINE = "--restart-worker" in sys.argv

def sh(cmd): return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
def call(path, body=None, token=None, method=None):
    req = urllib.request.Request(LEAF + path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method or ("POST" if body is not None else "GET"))
    req.add_header("content-type", "application/json")
    if token: req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:300]
def canopy(sql):
    return sh(f"docker exec flora-canopy-canopy-db-1 psql -U flora_admin -d flora -Atc \"{sql}\"")
def must(status_body, what):
    status, body = status_body
    if status != 200: raise SystemExit(f"{what} failed: {status} {body}")
    return body
results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}", flush=True)

token = must(call("/api/auth/login", {"username": "admin", "password": "admin"}), "login")["session_token"]
now = lambda: int(time.time() * 1000)
def start(hn):
    status, body = call("/api/case/start", {"start_time": now(), "admission_source": "manual", "hn": hn,
                        "patient_name": f"Sync test {hn}", "overlap_policy": "exclude"}, token)
    if status == 409 and isinstance(body, str) and "active" in body:
        raise SystemExit(f"active case already open on test leaf: {body}")
    return must((status, body), f"start {hn}")
def note(case_id, title, ts=None): return must(call(f"/api/case/{case_id}/events", {"title": title, "event_type": "note", "event_ts": ts or now()}, token), "note")["id"]
def discharge(case_id): return must(call("/api/case/discharge", {"case_id": case_id}, token), "discharge")["discharge_time"]
def case_id_of(hn):
    rows = must(call("/api/case/list?limit=50", token=token), "list")["rows"]
    return next(r["case_id"] for r in rows if r["hn"] == hn)

tag = str(int(time.time()))[-5:]
hn_a, hn_b, hn_c = f"SYNC-A-{tag}", f"SYNC-B-{tag}", f"SYNC-C-{tag}"
print("== online: start case A and wait until Canopy has it", flush=True)
start(hn_a); a = case_id_of(hn_a)
for _ in range(30):
    if canopy(f"select count(*) from sync_case_index where leaf_id='{LEAF_ID}' and hn='{hn_a}'") == "1": break
    time.sleep(2)
check("case A synced while online", canopy(f"select count(*) from sync_case_index where leaf_id='{LEAF_ID}' and hn='{hn_a}'") == "1")

print("== offline: stop Canopy sync API", flush=True)
offline_since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
sh("docker compose -f flora-canopy/compose.yaml stop sync-api")
time.sleep(6)
n1 = note(a, "A note 1"); n2 = note(a, "A note 2"); n3 = note(a, "A note 3")
must(call(f"/api/case/{a}/events/{n2}", {"title": "A note 2 (edited offline)"}, token, "PUT"), "edit")
must(call(f"/api/case/{a}/events/{n3}", {}, token, "DELETE"), "delete")
discharged_a = discharge(a)
start(hn_b); b = case_id_of(hn_b); note(b, "B note"); time.sleep(1); discharge(b)   # whole case lives offline
start(hn_c); c = case_id_of(hn_c); note(c, "C note")                                  # still active
note(a, "A note after discharge", discharged_a)  # late entry, backdated into the discharge minute
if RESTART_WORKER_OFFLINE:
    print("== restarting sync worker while offline (in-memory state lost)", flush=True)
    sh("docker restart flora-leaf-test-01-leaf-sync-1")
time.sleep(12)
check("worker kept retrying while offline", "sync failed" in sh(f"docker logs --since {offline_since} flora-leaf-test-01-leaf-sync-1 2>&1"))

print("== network back: start sync API, no worker restart", flush=True)
sh("docker compose -f flora-canopy/compose.yaml start sync-api")
deadline = time.time() + 90
def state(hn):
    raw = canopy(f"select status||'|'||(snapshot->'events')::text from sync_case_index where leaf_id='{LEAF_ID}' and hn='{hn}'")
    return raw.split("|", 1) if raw else (None, "")
while time.time() < deadline:
    if state(hn_c)[0] and state(hn_b)[0] and "after discharge" in state(hn_a)[1]: break
    time.sleep(3)
status_a, events_a = state(hn_a); status_b, events_b = state(hn_b); status_c, events_c = state(hn_c)
check("A: discharged status reached Canopy", status_a == "DISCHARGED", str(status_a))
check("A: offline notes present", "A note 1" in events_a and "A note 2 (edited offline)" in events_a)
check("A: deleted note gone", "A note 3" not in events_a)
check("A: note added after discharge synced", "A note after discharge" in events_a)
check("B: case started+discharged offline reached Canopy", status_b == "DISCHARGED", str(status_b))
check("B: its note present", "B note" in events_b)
check("C: active case and note present", status_c == "ACTIVE" and "C note" in events_c, str(status_c))
time.sleep(12)
dupes = canopy(f"select count(*) - count(distinct message_id) from sync_message where leaf_id='{LEAF_ID}'")
growth_1 = canopy(f"select count(*) from sync_message where leaf_id='{LEAF_ID}'"); time.sleep(12)
growth_2 = canopy(f"select count(*) from sync_message where leaf_id='{LEAF_ID}'")
check("no duplicate messages stored", dupes == "0", f"dupes={dupes}")
print(f"   messages stored: {growth_1} -> {growth_2} over 12s (active case C changes as vitals arrive)")
print("   last worker lines:", sh("docker logs --tail 3 flora-leaf-test-01-leaf-sync-1 2>&1").replace("\n", " | ")[:300])
print("== cleanup: discharge C", flush=True); discharge(c)
print(f"\n{sum(results)}/{len(results)} checks passed")
