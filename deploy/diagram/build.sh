#!/bin/sh
# Rebuild the whole-system diagram served at :30091 (namespace diagram, ConfigMap diagram-web).
# One box per cluster: Root, and each hospital (namespaces labelled flora/site=<code>, plus gateway-*.yaml).
set -e
cd "$(dirname "$0")"
python3 topology.py
kubectl -n diagram create configmap diagram-web --from-file=flora-diagram.svg \
  --from-literal=index.html="$(kubectl -n diagram get cm diagram-web -o jsonpath='{.data.index\.html}')" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1
kubectl -n diagram rollout restart deploy/diagram-web >/dev/null
ls -l flora-diagram.svg
