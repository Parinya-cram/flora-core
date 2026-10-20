#!/usr/bin/env python3
"""Whole-system diagram for :30091, drawn as the real deployment shape: Root is one cluster and every
hospital (site) is its own cluster holding its tiers (namespaces) and its gateway machines.

k8s part: live `kubectl` (namespaces labelled flora/site=<code>; flora-root is the Root cluster).
Gateway part: gateway-<host>.yaml next to this script (Docker Compose on the gateway machine,
modelled as Deployments + Services + PVCs; namespace label flora/site says which hospital owns it).
Output: flora-diagram.svg (Graphviz dot)."""
import json, subprocess, sys, html
from pathlib import Path
import yaml

HERE = Path(__file__).resolve().parent

def kubectl(*args):
    return json.loads(subprocess.check_output(["kubectl", *args, "-o", "json"]))

# ---------------------------------------------------------------- collect
sites: dict[str, dict] = {}          # site -> {title, namespaces: {ns: {deploy: {...}}}}
def ns_entry(site, ns, title=None):
    s = sites.setdefault(site, {"namespaces": {}})
    return s["namespaces"].setdefault(ns, {"title": title or ns, "workloads": {}})

for ns in kubectl("get", "ns")["items"]:
    name, labels = ns["metadata"]["name"], ns["metadata"].get("labels") or {}
    if name == "flora-root": site = "root"
    elif "flora/site" in labels: site = labels["flora/site"]
    else: continue
    entry = ns_entry(site, name)
    svcs = kubectl("get", "svc", "-n", name)["items"]
    pvcs = {p["metadata"]["name"] for p in kubectl("get", "pvc", "-n", name)["items"]}
    pods = kubectl("get", "pod", "-n", name)["items"]
    for kind in ("deploy", "sts", "ds"):
        for w in kubectl("get", kind, "-n", name)["items"]:
            wname, tmpl = w["metadata"]["name"], w["spec"]["template"]
            sel = w["spec"]["selector"].get("matchLabels") or {}
            ready = sum(1 for p in pods if all((p["metadata"].get("labels") or {}).get(k) == v for k, v in sel.items())
                        and all(c.get("ready") for c in p.get("status", {}).get("containerStatuses") or [{}]))
            ports = []
            for s in svcs:
                ssel = s["spec"].get("selector") or {}
                if ssel and all(tmpl["metadata"].get("labels", {}).get(k) == v for k, v in ssel.items()):
                    ports += [str(p["port"]) for p in s["spec"].get("ports") or []]
            hostports = [str(p["hostPort"]) for c in tmpl["spec"]["containers"] for p in c.get("ports") or [] if p.get("hostPort")]
            vols = [v["persistentVolumeClaim"]["claimName"] for v in tmpl["spec"].get("volumes") or [] if v.get("persistentVolumeClaim")]
            entry["workloads"][wname] = {"ports": ports, "host": hostports, "pvc": [v for v in vols if v in pvcs],
                                         "ready": ready, "want": w["spec"].get("replicas", 1) if kind != "ds" else ready,
                                         "worker": not ports and not hostports}

for f in sorted(HERE.glob("gateway-*.yaml")):
    docs = [d for d in yaml.safe_load_all(f.read_text()) if d]
    nsdoc = next(d for d in docs if d["kind"] == "Namespace")
    labels = nsdoc["metadata"].get("labels") or {}
    entry = ns_entry(labels.get("flora/site", "kcmh"), nsdoc["metadata"]["name"],
                     f"gateway {labels.get('host', '')} (docker compose)")
    for d in docs:
        if d["kind"] != "Deployment": continue
        n = d["metadata"]["name"]
        ports = [str(p["port"]) for s in docs if s["kind"] == "Service" and s["metadata"]["name"] == n for p in s["spec"]["ports"]]
        vols = [v["persistentVolumeClaim"]["claimName"] for v in d["spec"]["template"]["spec"].get("volumes") or []]
        entry["workloads"][n] = {"ports": ports, "host": [], "pvc": vols, "ready": None, "want": 1, "worker": not ports}

# ---------------------------------------------------------------- draw
TIER = {"canopy": ("#e8f1fb", "#3b7dd8"), "leaf": ("#eaf7ee", "#2f8f5b"), "appliance": ("#fdf3e3", "#c98a1c"),
        "gateway": ("#f4ecfb", "#8a4fc9"), "root": ("#fbeaea", "#c0504d")}
def tier(ns):
    for k in TIER:
        if k in ns: return k
    return "root"

out = ['digraph flora {', 'graph [rankdir=TB, fontname="Helvetica", fontsize=12, compound=true, nodesep=0.25, ranksep=0.6, bgcolor="#0f1319", pad=0.4];',
       'node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=10, color="#3a4652", fillcolor="#ffffff", margin="0.12,0.06"];',
       'edge [color="#8b98a5", fontname="Helvetica", fontsize=9, fontcolor="#8b98a5"];']
q = lambda s: '"' + s.replace('"', '\\"') + '"'
anchor = {}
for site in sorted(sites, key=lambda s: (s != "root", s)):
    title = "Root cluster · vendor control plane" if site == "root" else f"Hospital cluster · {site}"
    out.append(f'subgraph cluster_site_{site} {{ label=<<b>{html.escape(title)}</b>>; fontcolor="#e6edf3"; fontsize=15; '
               f'style="rounded,dashed"; color="{"#c0504d" if site == "root" else "#6dbb8f"}"; penwidth=2; margin=18;')
    for ns, entry in sites[site]["namespaces"].items():
        fill, line = TIER[tier(ns)]
        out.append(f'subgraph cluster_ns_{ns.replace("-", "_")} {{ label=<<b>{html.escape(entry["title"])}</b>>; fontcolor="{line}"; '
                   f'style="rounded,filled"; fillcolor="#1a2027"; color="{line}"; fontsize=12; margin=10;')
        for w, info in entry["workloads"].items():
            nid = f"{ns}/{w}"
            anchor.setdefault(ns, nid)
            lines = [f"<b>{html.escape(w)}</b>"]
            if info["ports"]: lines.append("svc :" + ", ".join(info["ports"]))
            if info["host"]: lines.append("host :" + ", ".join(info["host"]))
            if info["pvc"]: lines.append("disk " + ", ".join(info["pvc"]))
            if info["ready"] is not None: lines.append(f'pods {info["ready"]}/{info["want"]}')
            if info["worker"]: lines.append("<i>worker</i>")
            ok = info["ready"] is None or info["ready"] >= (info["want"] or 0)
            out.append(f'{q(nid)} [label=<{"<br/>".join(lines)}>, fillcolor="{fill}", color="{line if ok else "#e07a7a"}", penwidth={1.2 if ok else 2.5}];')
        out.append("}")
    out.append("}")

def link(a, b, label, style="solid", color="#8b98a5", extra=""):
    if a in anchor and b in anchor:
        out.append(f'{q(anchor[a])} -> {q(anchor[b])} [ltail=cluster_ns_{a.replace("-", "_")}, lhead=cluster_ns_{b.replace("-", "_")}, '
                   f'label={q(label)}, style={style}, color="{color}", fontcolor="{color}"{extra}];')

for site, s in sites.items():
    if site == "root": continue
    names = list(s["namespaces"])
    find = lambda k: next((n for n in names if k in n), None)
    app, can, leaf, gws = find("appliance"), find("canopy"), find("leaf"), [n for n in names if "gateway" in n]
    link("flora-root", app, "internet · license / releases ⇄ fleet report", "dashed", "#e0a84a", ", dir=both, penwidth=1.6")
    link(can, app, "device catalog · adopt")
    link(leaf, can, "sync (cases, config)")
    for g in gws:
        link(g, app, "check-in · parser images")
        link(g, leaf, "device data", "dotted", "#6dbb8f")
out.append("}")
dot = "\n".join(out)
(HERE / "flora-diagram.dot").write_text(dot)
subprocess.run(["dot", "-Tsvg", "-o", str(HERE / "flora-diagram.svg")], input=dot.encode(), check=True)
print("sites:", {k: list(v["namespaces"]) for k, v in sites.items()})
