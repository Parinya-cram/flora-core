#!/usr/bin/env bash
# One-line health per tier plus the end-to-end data path.
check() { if curl -fsS --cacert "${3:-flora-canopy/edge/certs/ca.crt}" --max-time 3 "$2" >/dev/null 2>&1; then printf '  %-28s up\n' "$1"; else printf '  %-28s DOWN  (%s)\n' "$1" "$2"; fi; }
ROOT_HTTPS_PORT=${ROOT_HTTPS_PORT:-8443} CANOPY_HTTPS_PORT=${CANOPY_HTTPS_PORT:-9443}
echo "Flora Root";    check "root api :7100"          http://localhost:7100/health
                      check "root edge :$ROOT_HTTPS_PORT"      "https://localhost:$ROOT_HTTPS_PORT/api/v1/keys" flora-root/edge/certs/ca.crt
                      check "root registry :7105"     http://localhost:7105/v2/
echo "Flora Canopy";  check "edge https :$CANOPY_HTTPS_PORT"    "https://localhost:$CANOPY_HTTPS_PORT/api/sync/v1/fingerprint"
                      check "canopy web :7200"        http://localhost:7200
                      check "sync api :7203"          http://localhost:7203/health
                      check "haber :7204"             http://localhost:7204/health
                      check "haber registry :7205"    http://localhost:7205/v2/
echo "Flora Gateway"; check "gateway service :7400"   http://localhost:7400/health
                      check "data-api (kong) :7410"   http://localhost:7410/data-api/health
                      check "simulator :7420"         http://localhost:7420/health
echo "Flora Leaf";    check "leaf-or-01 web :7300"    http://localhost:7300
                      check "leaf-or-01 api :7301"    http://localhost:7301/health
                      check "leaf-icu-01 web :7310"   http://localhost:7310
                      check "leaf-icu-01 api :7311"   http://localhost:7311/health
echo
python3 - <<'PY'
import base64, json, urllib.request
AUTH = "Basic " + base64.b64encode(b"admin:admin").decode()
def get(url):
    try:
        request = urllib.request.Request(url, headers={"authorization": AUTH})
        with urllib.request.urlopen(request, timeout=3) as r: return json.load(r)
    except Exception as e: return {"_error": str(e)}
h = get("http://localhost:7204/api/haber/v1/overview")
g = get("http://localhost:7400/api/license")
s = get("http://localhost:7410/data-api/api/devices/status")
print("License   root->haber:", "valid" if h.get("license_valid") else "NOT valid", "| gateway:", "valid" if g.get("valid") else f"NOT valid ({g.get('reason')})")
print("Usage    ", h.get("usage"))
summary = s.get("summary", {})
print(f"Devices   {summary.get('online_devices', 0)}/{summary.get('total_devices', 0)} online")
for d in s.get("devices", []):
    print(f"            {d['device_id']:20} {d['status']:8} -> {d.get('leaf_id')}")
approved = (h.get("releases") or {}).get("approvals", {})
print("Releases  approved:", ", ".join(f"{c}={a['release_id']}" for c, a in sorted(approved.items())) or "none")
for n in h.get("nodes", []):
    print(f"            {n['node_id']:20} {n.get('release_id') or 'dev build':16} {n['state']}{' - ' + n['detail'] if n.get('detail') else ''}")
PY
