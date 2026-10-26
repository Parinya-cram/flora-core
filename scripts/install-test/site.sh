#!/bin/sh
# Install test for the hospital site installer on the k8s pilot (floraicis), run by CI on demand:
#   SITE_TEST=install  plan a "site-test" hospital at Root, run site.sh into sitetest-* on spare ports
#   SITE_TEST=cleanup  remove the namespaces, the pulled images and the Root tenant again
# Runs as gitlab-runner (kubectl, sudo nerdctl). Never touches the real flora-* namespaces.
set -eu
ROOT=https://172.22.19.81:8443
case "${SITE_TEST:-}" in
install)
  CODE=$(python3 - "$ROOT" <<'PY'
import base64, json, ssl, sys, urllib.request, urllib.error
root = sys.argv[1]; ctx = ssl._create_unverified_context()
auth = {"authorization": "Basic " + base64.b64encode(b"admin:admin").decode(), "content-type": "application/json"}
def call(method, path, body=None):
    req = urllib.request.Request(root + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=auth)
    try:
        with urllib.request.urlopen(req, context=ctx) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code != 409: raise
        return {}
call("POST", "/api/v1/tenants", {"tenant_id": "site-test", "name": "Site install test (โรงพยาบาลทดสอบ)"})
print(call("POST", "/api/v1/tenants/site-test/installs", {"kind": "site", "valid_hours": 2})["code"])
PY
)
  curl -fsSk "$ROOT/install/site.sh" | sh -s -- --code "$CODE" --root "$ROOT" --root-insecure --existing-cluster \
    --prefix sitetest --ip 172.22.19.81 --canopy-port 9463 --haber-port 7224 --registry-port 7225 ;;
cleanup)
  kubectl delete ns sitetest-canopy sitetest-appliance --ignore-not-found --wait=true --timeout=300s
  kubectl -n flora-root exec deploy/root-db -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "
    BEGIN; DELETE FROM root_checkin WHERE tenant_id = '"'"'site-test'"'"';
    DELETE FROM root_license WHERE tenant_id = '"'"'site-test'"'"';
    DELETE FROM root_tenant WHERE tenant_id = '"'"'site-test'"'"'; COMMIT;"'
  for ref in $(sudo -n nerdctl -n k8s.io images --format '{{.Repository}}:{{.Tag}}' | grep '^flora-site/' || true); do
    sudo -n nerdctl -n k8s.io rmi -f "$ref" >/dev/null 2>&1 || true; done
  for ref in $(sudo -n nerdctl -n k8s.io images --format '{{.Repository}}@{{.Digest}}' | grep '^172.22.19.81:7105/' || true); do
    sudo -n nerdctl -n k8s.io rmi -f "$ref" >/dev/null 2>&1 || true; done
  echo "site test removed" ;;
inspect)
  # What the site installer left in containerd (the cluster's image store) and how the kubelet sees it.
  sudo -n nerdctl -n k8s.io images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Platform}} {{.Size}}' | grep -E 'flora-site|nginx|registry:' || true
  for img in flora-site/edge flora-site/registry; do
    echo "--- $img"; sudo -n nerdctl -n k8s.io image inspect "$(sudo -n nerdctl -n k8s.io images --format '{{.Repository}}:{{.Tag}}' | grep "$img" | head -1)" \
      --format '{{.RepoTags}} {{.Os}}/{{.Architecture}}' 2>&1 | head -3
  done
  kubectl -n sitetest-canopy get pods -o wide ;;
*) echo "set SITE_TEST=install, cleanup or inspect" >&2; exit 2 ;;
esac
