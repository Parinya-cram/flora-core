"""Shared pieces of the FormDev large-dataset harness (Phase 4.13).

Nothing here changes the engine: the harness only drives the real repositories, QueryEngine,
JobService and JobWorker, and reads plans with EXPLAIN. Every entry point refuses a database
whose name does not end in ``_test``.
"""
from __future__ import annotations

import json
import os
import random
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DOCS = REPO / "formdev" / "docs" / "perf"
PLANS = DOCS / "plans"
RESULTS = DOCS / "results"
sys.path.insert(0, str(REPO / "services" / "flora-api"))

from app.formdev import services_for  # noqa: E402
from app.formdev.definition import datetime_epoch_ms, index_entries, subject_value  # noqa: E402
from app.formdev.query.access import Principal  # noqa: E402
from app.formdev.styles import stored_font  # noqa: E402

USER = "perf-loader"
MIN_FREE_BYTES = 3 * 1024 ** 3
DAY_MS = 86_400_000
T0 = int(datetime(2024, 10, 1, tzinfo=timezone.utc).timestamp() * 1000)
T_END = int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp() * 1000)
BKK = timezone(timedelta(hours=7))

READER = Principal(21, "perf_reader", ("clinician",), ("formdev.query",))
EXPORTER = Principal(22, "perf_exporter", ("clinical_admin", "clinician"), ("formdev.query", "formdev.export"))
PRINCIPALS = {READER.user_id: READER, EXPORTER.user_id: EXPORTER}


# Safety ----------------------------------------------------------------------------------------
def require_test_url(url: str) -> str:
    name = urlparse(url).path.lstrip("/")
    if not name.endswith("_test"):
        raise SystemExit(f"refusing to run: database '{name}' does not end in _test")
    return url


def require_test_path(path: str | Path) -> Path:
    path = Path(path)
    if not path.stem.endswith("_test"):
        raise SystemExit(f"refusing to run: SQLite file '{path.name}' does not end in _test")
    return path


def database_url() -> str:
    """PERF_DATABASE_URL, or PERF_PG_USER/PERF_PG_PASSWORD/PERF_PG_HOST/PERF_PG_DB (run.sh passes these so
    the password never appears on a command line)."""
    url = os.environ.get("PERF_DATABASE_URL", "")
    if not url and os.environ.get("PERF_PG_USER"):
        from urllib.parse import quote

        url = (f"postgresql://{quote(os.environ['PERF_PG_USER'], safe='')}:{quote(os.environ.get('PERF_PG_PASSWORD', ''), safe='')}"
               f"@{os.environ.get('PERF_PG_HOST', 'postgres')}:5432/{os.environ.get('PERF_PG_DB', 'flora_formdev_perf_test')}")
    if not url:
        raise SystemExit("set PERF_DATABASE_URL=postgresql://user:password@host:5432/<name>_test")
    return require_test_url(url)


def host_free_bytes() -> int:
    """Free space of the host disk (the repository bind mount reports the host filesystem)."""
    stat = os.statvfs(REPO)
    return stat.f_bavail * stat.f_frsize


class DiskLow(Exception):
    pass


def check_disk(stage: str, reserve: int = 0) -> int:
    free = host_free_bytes()
    if free - reserve < MIN_FREE_BYTES:
        raise DiskLow(f"{stage}: host free {free / 1e9:.2f} GB (reserve {reserve / 1e9:.2f} GB) would drop below 3 GB")
    return free


# Connections -------------------------------------------------------------------------------------
def connect(url: str | None = None):
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(require_test_url(url or database_url()), autocommit=True, row_factory=dict_row)


def pg_services(connection, adapter_class=None):
    from app.formdev.adapters.postgres import PostgreSQLAdapter

    return services_for((adapter_class or PostgreSQLAdapter)(connection))


# Form definitions ------------------------------------------------------------------------------------
WARDS = [f"W{n:02d}" for n in range(1, 19)] + ["W_BIG", "W_RARE"]


def _option(value: str) -> dict[str, str]:
    return {"value": value, "label": value}


def assessment_definition(form_id: str = "perf_assessment") -> dict[str, Any]:
    return {
        "format": "flora.form/1", "form_id": form_id, "schema_version": 1, "title": "Perf assessment", "paper": "A4",
        "style_id": "form.a4.medical", "extensions": {"flora.subject_field": "hn"},
        "sections": [{"id": "main", "title": "Main", "fields": [
            {"id": "hn", "type": "text", "label": "HN", "indexed": True},
            {"id": "ward", "type": "select", "label": "Ward", "indexed": True, "options": [_option(w) for w in WARDS]},
            {"id": "age", "type": "integer", "label": "Age", "indexed": True, "min": 0, "max": 120},
            {"id": "fall_risk", "type": "select", "label": "Fall risk", "indexed": True, "options": [_option("no"), _option("yes")]},
            {"id": "assessed_at", "type": "datetime", "label": "Assessed at", "indexed": True},
            {"id": "score", "type": "number", "label": "Score", "indexed": True, "min": 0, "max": 100},
            {"id": "weight_kg", "type": "number", "label": "Weight", "unit": "kg"},
            {"id": "height_cm", "type": "number", "label": "Height", "unit": "cm"},
            {"id": "bmi", "type": "calculated", "label": "BMI", "indexed": True, "formula": "weight_kg / ((height_cm / 100) * (height_cm / 100))"},
            {"id": "full_name", "type": "text", "label": "Name"},
            {"id": "remarks", "type": "textarea", "label": "Remarks"},
        ]}],
    }


def registration_definition() -> dict[str, Any]:
    return {
        "format": "flora.form/1", "form_id": "perf_registration", "schema_version": 1, "title": "Perf registration", "paper": "A4",
        "style_id": "form.a4.medical", "extensions": {"flora.subject_field": "hn"},
        "sections": [{"id": "main", "title": "Main", "fields": [
            {"id": "hn", "type": "text", "label": "HN", "indexed": True},
            {"id": "name", "type": "text", "label": "Name"},
        ]}],
    }


NOISE_FORMS = ("a_noise_vitals", "m_noise_labs", "z_noise_notes")
NOISE_SHARE = (0.4, 0.3, 0.3)


def noise_definition(form_id: str) -> dict[str, Any]:
    """Noise forms reuse field ids (hn, ward, age, score) so index rows of other forms share the field_id."""
    fields = [
        {"id": "hn", "type": "text", "label": "HN", "indexed": True},
        {"id": "ward", "type": "select", "label": "Ward", "indexed": True, "options": [_option(w) for w in WARDS]},
        {"id": "age", "type": "integer", "label": "Age", "indexed": True},
        {"id": "score", "type": "number", "label": "Score", "indexed": True},
        {"id": "assessed_at", "type": "datetime", "label": "At", "indexed": True},
        {"id": "note", "type": "textarea", "label": "Note"},
    ]
    return {"format": "flora.form/1", "form_id": form_id, "schema_version": 1, "title": f"Noise {form_id}", "paper": "A4",
            "style_id": "form.a4.medical", "extensions": {"flora.subject_field": "hn"},
            "sections": [{"id": "main", "title": "Main", "fields": fields}]}


SOURCE = {"source_id": "perf_with_patient", "form_id": "perf_assessment", "version": 1, "updated_at": 0, "updated_by": USER,
          "config": {"relations": {"patient": {"source": "perf_registration", "local": "hn", "foreign": "hn"}}}}


def ensure_forms(services: Any, with_scratch: bool = True) -> None:
    """Create and publish every perf form through the real repositories (idempotent)."""
    definitions = [assessment_definition(), registration_definition(), *(noise_definition(f) for f in NOISE_FORMS)]
    if with_scratch:
        definitions.append(assessment_definition("perf_scratch"))
    styles = set(services.styles.style_ids())
    if "form.a4.medical" not in styles:
        for font in json.loads((REPO / "formdev" / "registry" / "fonts.json").read_text()):
            services.styles.save_font(font["font_id"], stored_font(font))
        for style in json.loads((REPO / "formdev" / "registry" / "styles.json").read_text()):
            services.styles.save_style(style["style_id"], style["definition"], style["version"])
    for definition in definitions:
        if services.adapter.get_form(definition["form_id"]) is None:
            services.schemas.create_form(definition, USER)
            services.schemas.publish(definition["form_id"], 1, USER)
    if services.adapter.get_source(SOURCE["source_id"]) is None:
        services.adapter.save_source(SOURCE)


# Synthetic data ---------------------------------------------------------------------------------------------
THAI_FIRST = ["สมชาย", "สมหญิง", "วิชัย", "มาลี", "ประเสริฐ", "จันทร์เพ็ญ", "Somchai", "Malee", "Anan", "Kanya", "Narong", "Pim"]
THAI_LAST = ["ใจดี", "รักไทย", "ศรีสุข", "มั่นคง", "Wongsa", "Suksawat", "Chaiyaporn", "Thongdee"]
WORDS = ("stable alert oriented pain mild moderate severe ambulates assist walker bed rest fluids iv oral diet monitor bp hr spo2 "
         "fall precautions bed alarm side rails call bell reviewed family education ปวด เวียนศีรษะ ไม่มีไข้ นอนหลับได้ ญาติเฝ้า").split()
USERS = [f"nurse{n:02d}" for n in range(1, 41)]
SMALL_WARDS = WARDS[:18]
SMALL_WEIGHTS = [1.0 / (rank + 1) for rank in range(18)]


def iso(ms: int, utc: bool) -> str:
    moment = datetime.fromtimestamp(ms / 1000, tz=timezone.utc if utc else BKK)
    return moment.strftime("%Y-%m-%dT%H:%M:%S") + ("Z" if utc else "+07:00")


class Generator:
    """Deterministic generator. Records come out in global ingest order (all forms interleaved),
    each with the formdev_record columns and the data the real write path would store."""

    def __init__(self, records: int, noise: int, seed: int = 4013):
        self.n = records
        self.noise = noise
        self.patients = max(1, records // 10)
        self.rare = max(1, round(records * 0.0005))
        self.rng = random.Random(seed)
        self.definitions = {"perf_assessment": assessment_definition(), "perf_registration": registration_definition(),
                            **{form_id: noise_definition(form_id) for form_id in NOISE_FORMS}}
        self.registrations = self.patients + max(1, self.patients // 100)

    # Timeline ---------------------------------------------------------------------------------------
    def _timeline(self) -> list[tuple[int, int, int, int]]:
        """(ingested_at, form code, local index, created_at) for every record, sorted by ingest time."""
        rng = random.Random(self.rng.random())
        out: list[tuple[int, int, int, int]] = []
        # perf_assessment: W_RARE records are the oldest (first 12 h) and ingested first; the rest
        # start a day later. Sync delays (exponential, 5% offline for 1-7 days) reorder ingest vs created_at.
        created = sorted(rng.randint(T0 + DAY_MS, T_END) for _ in range(self.n - self.rare))
        rare = sorted(rng.randint(T0, T0 + DAY_MS // 2) for _ in range(self.rare))
        for index, at in enumerate(rare + created):
            if index < self.rare:
                delay = rng.randint(0, 60_000)
            elif rng.random() < 0.05:
                delay = rng.randint(DAY_MS, 7 * DAY_MS)
            else:
                delay = int(rng.expovariate(1 / 7_200_000))
            out.append((at + delay + 7_200_000, 0, index, at))
        for _ in range(self.registrations):
            at = rng.randint(T0, T_END)
            out.append((at + int(rng.expovariate(1 / 600_000)), 1, len(out), at))
        for code, (form_id, share) in enumerate(zip(NOISE_FORMS, NOISE_SHARE), start=2):
            for _ in range(int(self.noise * share)):
                at = rng.randint(T0, T_END)
                out.append((at + int(rng.expovariate(1 / 3_600_000)), code, 0, at))
        out.sort()
        return out

    # Records ------------------------------------------------------------------------------------------
    def _assessment(self, index: int, created: int) -> dict[str, Any]:
        rng = self.rng
        if index < self.rare:
            ward = "W_RARE"
        elif rng.random() < 0.30 / (1 - 0.0005):
            ward = "W_BIG"
        else:
            ward = rng.choices(SMALL_WARDS, SMALL_WEIGHTS)[0]
        weight, height = round(rng.uniform(38, 120), 1), round(rng.uniform(140, 195), 1)
        data: dict[str, Any] = {
            "hn": f"HN{rng.randrange(self.patients):07d}", "ward": ward,
            "fall_risk": "yes" if rng.random() < 0.20 else "no",
            "assessed_at": iso(created - rng.randint(0, 6 * 3_600_000), utc=rng.random() < 0.5),
            "score": round(rng.uniform(0, 100), 1), "weight_kg": weight, "height_cm": height,
            "bmi": round(weight / ((height / 100) ** 2), 2),
            "full_name": f"{rng.choice(THAI_FIRST)} {rng.choice(THAI_LAST)} {rng.randrange(1000)}",
        }
        if rng.random() >= 0.25:
            data["age"] = rng.randint(0, 100)
        if rng.random() < 0.8:
            data["remarks"] = " ".join(rng.choice(WORDS) for _ in range(rng.randint(3, 30)))
        return data

    def _noise(self, form_id: str, created: int) -> dict[str, Any]:
        rng = self.rng
        data: dict[str, Any] = {"hn": f"HN{rng.randrange(self.patients):07d}", "ward": rng.choice(WARDS[:19]),
                                "score": round(rng.uniform(0, 100), 1), "assessed_at": iso(created, utc=rng.random() < 0.5)}
        if rng.random() < 0.7:
            data["age"] = rng.randint(0, 100)
        if rng.random() < 0.5:
            data["note"] = " ".join(rng.choice(WORDS) for _ in range(rng.randint(2, 20)))
        return data

    def records(self) -> Iterator[dict[str, Any]]:
        rng = self.rng
        seqs: dict[str, int] = {}
        reg_index = 0
        for ingested_at, code, index, created in self._timeline():
            if code == 0:
                form_id, data = "perf_assessment", self._assessment(index, created)
            elif code == 1:
                form_id = "perf_registration"
                patient = reg_index if reg_index < self.patients else rng.randrange(self.patients)
                data = {"hn": f"HN{patient:07d}", "name": f"{rng.choice(THAI_FIRST)} {rng.choice(THAI_LAST)}"}
                reg_index += 1
            else:
                form_id = NOISE_FORMS[code - 2]
                data = self._noise(form_id, created)
            roll = rng.random()
            status = "deleted" if roll < 0.01 else "draft" if roll < 0.03 else "submitted"
            if code == 1 and reg_index > self.patients:
                status = "draft"  # duplicate registrations: ambiguous relation keys, ranked below submitted
            updated = created if rng.random() < 0.6 else created + rng.randint(0, 7_200_000)
            version = 1 if updated == created else 2
            if status == "deleted":
                updated, version = ingested_at + rng.randint(3_600_000, 30 * DAY_MS), version + 1
            seqs[form_id] = seqs.get(form_id, 0) + 1
            user = rng.choice(USERS)
            yield {
                "record_id": str(uuid.UUID(int=rng.getrandbits(128), version=4)), "form_id": form_id, "schema_version": 1,
                "status": status, "data": data, "created_at": created, "created_by": user, "updated_at": updated,
                "updated_by": user if version == 1 else rng.choice(USERS), "sync_id": None, "version": version,
                "subject_id": subject_value(self.definitions[form_id], data), "ingest_seq": seqs[form_id], "ingested_at": ingested_at,
            }


def index_rows(definition: dict[str, Any], record: dict[str, Any]) -> list[tuple[Any, ...]]:
    """formdev_record_index rows for a record: the REAL index_entries + the record's status/updated_at."""
    return [(record["record_id"], record["form_id"], entry["field_id"], entry["value_text"], entry["value_num"], record["status"], record["updated_at"])
            for entry in index_entries(definition, record["data"])]


# Plans ---------------------------------------------------------------------------------------------------
KEEP = {"Node Type": "node", "Parent Relationship": "parent", "Join Type": "join", "Strategy": "strategy", "Relation Name": "relation",
        "Index Name": "index", "Alias": "alias", "Scan Direction": "direction", "Plan Rows": "est_rows", "Actual Rows": "act_rows",
        "Actual Loops": "loops", "Rows Removed by Filter": "removed_by_filter", "Rows Removed by Index Recheck": "removed_by_recheck",
        "Rows Removed by Join Filter": "removed_by_join_filter", "Heap Fetches": "heap_fetches", "Shared Hit Blocks": "shared_hit",
        "Shared Read Blocks": "shared_read", "Temp Read Blocks": "temp_read", "Temp Written Blocks": "temp_written",
        "Sort Method": "sort_method", "Sort Space Type": "sort_space", "Sort Space Used": "sort_kb", "Presorted Key": "presorted",
        "Actual Total Time": "act_ms", "Workers Launched": "workers", "Peak Memory Usage": "peak_kb", "Disk Usage": "disk_kb",
        "HashAgg Batches": "hashagg_batches"}
CONDITIONS = ("Index Cond", "Filter", "Hash Cond", "Join Filter", "Recheck Cond", "Sort Key", "Group Key")


def trim_plan(document: Any) -> dict[str, Any]:
    root = document[0] if isinstance(document, list) else document
    nodes: list[dict[str, Any]] = []

    def walk(node: dict[str, Any], depth: int) -> None:
        item: dict[str, Any] = {"depth": depth}
        for key, short in KEEP.items():
            if key in node and node[key] not in (None, [], ""):
                item[short] = node[key]
        for key in CONDITIONS:
            if key in node:
                value = node[key] if isinstance(node[key], str) else ", ".join(map(str, node[key]))
                item[key.lower().replace(" ", "_")] = value if len(value) <= 240 else value[:237] + "..."
        nodes.append(item)
        for child in node.get("Plans") or []:
            walk(child, depth + 1)

    walk(root["Plan"], 0)
    planning = root.get("Planning") or {}
    return {"planning_ms": root.get("Planning Time"), "execution_ms": root.get("Execution Time"),
            "planning_buffers": (planning.get("Shared Hit Blocks", 0) + planning.get("Shared Read Blocks", 0)) if planning else None,
            "settings": root.get("Settings") or {}, "nodes": nodes}


def plan_facts(trimmed: dict[str, Any]) -> dict[str, Any]:
    nodes = trimmed["nodes"]
    top = nodes[0]
    scans = [n for n in nodes if "Scan" in n.get("node", "")]
    loops = lambda n: max(1, int(n.get("loops", 1)))  # noqa: E731
    est, act = float(top.get("est_rows", 0)), float(top.get("act_rows", 0))
    worst = 1.0
    worst_node = None
    for node in nodes:
        if "act_rows" not in node or node.get("loops", 1) == 0:
            continue
        e, a = max(float(node.get("est_rows", 0)), 1.0), max(float(node["act_rows"]), 1.0)
        ratio = max(e / a, a / e)
        if ratio > worst:
            worst, worst_node = ratio, f"{node['node']}{' ' + node['index'] if 'index' in node else ' ' + node['relation'] if 'relation' in node else ''}"
    return {
        "node_types": [n["node"] for n in nodes],
        "indexes": sorted({n["index"] for n in nodes if "index" in n}),
        "seq_scans": sorted({n.get("relation", "?") for n in nodes if n["node"] == "Seq Scan"}),
        "external_sort": any("external" in str(n.get("sort_method", "")).lower() or n.get("sort_space") == "Disk" for n in nodes),
        "spilled": any(n.get("temp_written") or n.get("disk_kb") for n in nodes),
        "sort_methods": sorted({n["sort_method"] for n in nodes if "sort_method" in n}),
        "top_est": est, "top_act": act, "top_ratio": max(max(est, 1) / max(act, 1), max(act, 1) / max(est, 1)),
        "worst_ratio": round(worst, 1), "worst_node": worst_node,
        "rows_scanned": int(sum(float(n.get("act_rows", 0)) * loops(n) + float(n.get("removed_by_filter", 0)) * loops(n) for n in scans)),
        "removed_by_filter": int(sum(float(n.get("removed_by_filter", 0)) * loops(n) for n in nodes)),
        "heap_fetches": int(sum(float(n.get("heap_fetches", 0)) for n in nodes)),
        "buffers": int(top.get("shared_hit", 0)) + int(top.get("shared_read", 0)),
        "shared_read": int(top.get("shared_read", 0)),
        "planning_ms": trimmed["planning_ms"], "execution_ms": trimmed["execution_ms"],
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1, default=str) + "\n", encoding="utf-8")


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def epoch(text: str) -> int:
    value = datetime_epoch_ms(text)
    assert value is not None
    return value


@contextmanager
def timed(store: dict[str, float], key: str):
    import time

    started = time.perf_counter()
    try:
        yield
    finally:
        store[key] = round(time.perf_counter() - started, 3)
