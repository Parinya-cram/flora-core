"""Import versioned clinical terminology releases into Flora PostgreSQL.

Public baseline:
  python scripts/import-terminology.py public-baseline

Hospital-supplied ICD-10-TM TSV/CSV:
  python scripts/import-terminology.py generic --system ICD_10_TM --edition Thailand \
    --version 2016 --domain diagnosis --source ICD10TM.tsv

Thai Medicines Terminology (TMT, from the THIS release; CSV/TSV with tmtid, fsn, level = SUBS/VTM/GP/GPU/TP/TPU):
  python scripts/import-terminology.py tmt --source TMT_GPU.csv --version 20260901
  python scripts/import-terminology.py tmt-map --source item_tmt.csv     (columns item_code, tmtid: link catalogue drugs)

Licensed SNOMED CT RF2 Snapshot ZIP:
  python scripts/import-terminology.py snomed-rf2 --source SnomedCT_InternationalRF2.zip \
    --edition International --version 20260701
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import psycopg

CMS_ICD9_URL = "https://www.cms.gov/medicare/coding/icd9providerdiagnosticcodes/downloads/icd-9-cm-v32-master-descriptions.zip"
WHO_ICD10_URL = "https://icdcdn.who.int/icd10/claml/icd102019en.xml.zip"
UCUM_URL = "https://raw.githubusercontent.com/ucum-org/ucum/main/ucum-essence.xml"


def materialize(source: str) -> tuple[Path, bool]:
    if source.startswith(("http://", "https://")):
        suffix = Path(source.split("?", 1)[0]).suffix
        handle = tempfile.NamedTemporaryFile(prefix="flora-terminology-", suffix=suffix, delete=False)
        handle.close()
        urllib.request.urlretrieve(source, handle.name)
        return Path(handle.name), True
    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    return path, False


def clean_display(value: str) -> str:
    return " ".join(str(value or "").strip().split())


def icd9_code(raw: str) -> str:
    raw = raw.strip()
    return f"{raw[:2]}.{raw[2:]}" if len(raw) > 2 else raw


def icd9_entries(source: str) -> list[dict]:
    path, temporary = materialize(source)
    try:
        with zipfile.ZipFile(path) as archive:
            long_name = next(name for name in archive.namelist() if name.endswith("DESC_LONG_SG.txt"))
            short_name = next(name for name in archive.namelist() if name.endswith("DESC_SHORT_SG.txt"))
            def parse(name: str) -> dict[str, str]:
                result = {}
                with archive.open(name) as raw:
                    for line in io.TextIOWrapper(raw, encoding="cp1252"):
                        parts = line.rstrip().split(maxsplit=1)
                        if len(parts) == 2:
                            result[parts[0]] = clean_display(parts[1])
                return result
            long, short = parse(long_name), parse(short_name)
        return [{"domain":"procedure", "code":icd9_code(code), "display":display,
                 "metadata":{"short_display":short.get(code), "raw_code":code}}
                for code, display in long.items()]
    finally:
        if temporary: path.unlink(missing_ok=True)


def who_icd10_entries(source: str) -> list[dict]:
    path, temporary = materialize(source)
    try:
        with zipfile.ZipFile(path) as archive:
            xml_name = next(name for name in archive.namelist() if name.lower().endswith(".xml"))
            root = ElementTree.parse(archive.open(xml_name)).getroot()
        result = []
        for item in root.findall("Class"):
            if item.attrib.get("kind") != "category":
                continue
            code = clean_display(item.attrib.get("code", ""))
            preferred = item.find("Rubric[@kind='preferred']/Label")
            display = clean_display("".join(preferred.itertext()) if preferred is not None else "")
            parent = item.find("SuperClass")
            if code and display:
                result.append({"domain":"diagnosis", "code":code, "display":display,
                    "parent_code":parent.attrib.get("code") if parent is not None else None,
                    "is_billable":0 if item.find("SubClass") is not None else 1,
                    "metadata":{"kind":"category"}})
        return result
    finally:
        if temporary: path.unlink(missing_ok=True)


def ucum_entries(source: str) -> list[dict]:
    path, temporary = materialize(source)
    try:
        root = ElementTree.parse(path).getroot()
        namespace = {"u": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}
        result = []
        for element_name in ("base-unit", "unit"):
            query = f"u:{element_name}" if namespace else element_name
            for element in root.findall(query, namespace):
                code = element.attrib.get("Code", "").strip()
                name_node = element.find("u:name" if namespace else "name", namespace)
                display = clean_display(name_node.text if name_node is not None else code)
                if code:
                    result.append({"domain":"unit", "code":code, "display":display,
                                   "metadata":{"kind":element_name, "class":element.attrib.get("class"), "metric":element.attrib.get("isMetric")}})
        return result
    finally:
        if temporary: path.unlink(missing_ok=True)


def generic_entries(args) -> list[dict]:
    path, temporary = materialize(args.source)
    try:
        with path.open("r", encoding=args.encoding, newline="") as handle:
            sample = handle.read(4096); handle.seek(0)
            delimiter = args.delimiter or ("\t" if "\t" in sample else ",")
            reader = csv.DictReader(handle, delimiter=delimiter)
            result = []
            for row in reader:
                code = clean_display(row.get(args.code_column, ""))
                display = clean_display(row.get(args.display_column, ""))
                if code and display:
                    result.append({"domain":args.domain, "code":code, "display":display,
                        "display_th":clean_display(row.get(args.thai_column, "")) or None,
                        "parent_code":clean_display(row.get(args.parent_column, "")) or None,
                        "metadata":{"source_row":row}})
            return result
    finally:
        if temporary: path.unlink(missing_ok=True)


def snomed_entries(source: str) -> list[dict]:
    path, temporary = materialize(source)
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            concept_name = next(name for name in names if "Snapshot/Terminology/sct2_Concept_Snapshot" in name and name.endswith(".txt"))
            description_name = next(name for name in names if "Snapshot/Terminology/sct2_Description_Snapshot-en" in name and name.endswith(".txt"))
            active = set()
            with archive.open(concept_name) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"), delimiter="\t")
                active.update(row["id"] for row in reader if row["active"] == "1")
            result = []
            with archive.open(description_name) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"), delimiter="\t")
                for row in reader:
                    if row["active"] != "1" or row["conceptId"] not in active or row["typeId"] != "900000000000003001":
                        continue
                    term = clean_display(row["term"])
                    tag_match = re.search(r"\s+\(([^()]+)\)$", term)
                    semantic_tag = tag_match.group(1).lower() if tag_match else ""
                    domain = "diagnosis" if semantic_tag in {"disorder","finding"} else "procedure" if semantic_tag in {"procedure","regime/therapy"} else None
                    if domain:
                        result.append({"domain":domain, "code":row["conceptId"], "display":term,
                                       "metadata":{"semantic_tag":semantic_tag, "module_id":row["moduleId"]}})
            return result
    finally:
        if temporary: path.unlink(missing_ok=True)


TMT_URI = "http://www.this.or.th/tmt"


def tmt_entries(args) -> list[dict]:
    """TMT concept table(s) as one CSV/TSV: tmtid, fsn, level (column names overridable). Medication domain."""
    path, temporary = materialize(args.source)
    try:
        with path.open("r", encoding=args.encoding, newline="") as handle:
            sample = handle.read(4096); handle.seek(0)
            reader = csv.DictReader(handle, delimiter=args.delimiter or ("\t" if "\t" in sample else ","))
            lowered = lambda row: {str(k or "").strip().lower(): v for k, v in row.items()}
            result = []
            for row in map(lowered, reader):
                code = clean_display(row.get("tmtid") or row.get("tmt_id") or row.get("code") or "")
                display = clean_display(row.get("fsn") or row.get("display") or "")
                if code and display:
                    level = clean_display(row.get("level") or "").upper() or None
                    result.append({"domain":"medication", "code":code, "display":display,
                        "display_th":clean_display(row.get("fsn_th") or row.get("display_th") or "") or None,
                        "is_billable":0, "metadata":{"level":level}})
            return result
    finally:
        if temporary: path.unlink(missing_ok=True)


def map_tmt(database, source: str, encoding: str) -> tuple[int, list[str]]:
    """Link io_item_master drugs (item_code) to TMT codes (tmtid) as clinical_concept_coding TMT rows."""
    now = int(time.time() * 1000); linked = 0; missing = []
    with open(source, "r", encoding=encoding, newline="") as handle, database.transaction():
        sample = handle.read(4096); handle.seek(0)
        for row in csv.DictReader(handle, delimiter="\t" if "\t" in sample else ","):
            code, tmtid = clean_display(row.get("item_code", "")), clean_display(row.get("tmtid", ""))
            item = database.execute("SELECT concept_id FROM io_item_master WHERE kind='med' AND code=%s", (code,)).fetchone()
            if not item or not item[0] or not tmtid:
                missing.append(code); continue
            entry = database.execute(
                """SELECT e.id, e.display FROM terminology_entry e JOIN terminology_release r ON r.id=e.release_id
                   WHERE r.system_key='TMT' AND r.status='active' AND e.code=%s LIMIT 1""", (tmtid,)).fetchone()
            database.execute(
                """INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,is_preferred,terminology_entry_id,created_at,updated_at)
                   VALUES (%s,'TMT',%s,%s,%s,1,%s,%s,%s)
                   ON CONFLICT(concept_id,system_key,code) DO UPDATE SET display=excluded.display,
                     terminology_entry_id=excluded.terminology_entry_id,updated_at=excluded.updated_at""",
                (item[0], TMT_URI, tmtid, entry[1] if entry else None, entry[0] if entry else None, now, now))
            linked += 1
    return linked, missing


def import_release(database, *, system: str, system_uri: str, edition: str, version: str,
                   source_uri: str, license_name: str, license_uri: str, entries: list[dict], release_date: str | None = None):
    now = int(time.time() * 1000)
    with database.transaction():
        release = database.execute(
            """INSERT INTO terminology_release(system_key,system_uri,edition,version,release_date,source_uri,license_name,license_uri,status,imported_at,entry_count)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'staged',%s,0)
               ON CONFLICT(system_key,edition,version) DO UPDATE SET system_uri=excluded.system_uri,release_date=excluded.release_date,
                 source_uri=excluded.source_uri,license_name=excluded.license_name,license_uri=excluded.license_uri,status='staged',imported_at=excluded.imported_at
               RETURNING id""",
            (system,system_uri,edition,version,release_date,source_uri,license_name,license_uri,now),
        ).fetchone()
        release_id = release[0]
        database.execute("DELETE FROM terminology_entry WHERE release_id=%s", (release_id,))
        with database.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO terminology_entry(release_id,domain,code,display,display_th,definition,parent_code,is_billable,is_active,metadata)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(release_id,item["domain"],item["code"],item["display"],item.get("display_th"),item.get("definition"),item.get("parent_code"),
                  int(item.get("is_billable",1)),int(item.get("is_active",1)),json.dumps(item.get("metadata",{}),ensure_ascii=False)) for item in entries],
            )
        database.execute("UPDATE terminology_release SET status='active',entry_count=%s WHERE id=%s", (len(entries),release_id))
        database.execute("UPDATE terminology_release SET status='superseded' WHERE system_key=%s AND edition=%s AND id<>%s AND status='active'", (system,edition,release_id))
    return release_id


def sync_icd9_compatibility(database, entries: list[dict]):
    now = int(time.time() * 1000)
    with database.transaction():
        raw_codes = [item["metadata"].get("raw_code") or item["code"].replace(".","") for item in entries]
        database.execute("DELETE FROM icd9cm_master WHERE position('.' in icd9cm)>0 AND replace(icd9cm,'.','')=ANY(%s)", (raw_codes,))
        with database.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO icd9cm_master(icd9cm,short_name_en,name_en,created_at,updated_at) VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT(icd9cm) DO UPDATE SET short_name_en=excluded.short_name_en,name_en=excluded.name_en,updated_at=excluded.updated_at""",
                [(raw_codes[index],item["metadata"].get("short_display"),item["display"],now,now) for index,item in enumerate(entries)],
            )


def sync_icd10_compatibility(database, entries: list[dict]):
    now = int(time.time() * 1000)
    with database.transaction():
        with database.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO icd10_master(icd10,icd10who,name_en,name_th,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT(icd10) DO UPDATE SET icd10who=excluded.icd10who,name_en=excluded.name_en,
                     name_th=coalesce(excluded.name_th,icd10_master.name_th),updated_at=excluded.updated_at""",
                [(item["code"],item["code"],item["display"],item.get("display_th"),now,now) for item in entries],
            )


def materialize_icd_masters(database):
    """Create editable Flora master concepts from each active ICD catalog entry."""
    now = int(time.time() * 1000)
    specifications = (
        ("diagnosis", "ICD_10_WHO", "ICD_10", "icd10"),
        ("procedure", "ICD_9_CM", "ICD_9_CM", "icd9cm"),
    )
    totals = {}
    with database.transaction():
        for domain, release_system, coding_system, prefix in specifications:
            rows = database.execute(
                """SELECT entry.id,entry.code,entry.display,release.system_uri,release.version
                   FROM terminology_entry entry JOIN terminology_release release ON release.id=entry.release_id
                   WHERE release.system_key=%s AND release.status='active' AND entry.domain=%s AND entry.is_active=1
                   ORDER BY entry.code""",
                (release_system, domain),
            ).fetchall()
            # Keep historical concepts addressable, but expose only entries in the
            # currently active release through the active clinical master list.
            database.execute(
                "UPDATE clinical_concept SET is_active=0,updated_at=%s WHERE domain=%s AND local_id LIKE %s",
                (now, domain, prefix + "-%"),
            )
            with database.cursor() as cursor:
                cursor.executemany(
                    """INSERT INTO clinical_concept(domain,local_id,local_name,is_active,created_at,updated_at)
                       VALUES (%s,%s,%s,1,%s,%s)
                       ON CONFLICT(domain,local_id) DO UPDATE SET is_active=1,updated_at=excluded.updated_at""",
                    [(domain, f"{prefix}-{re.sub(r'[^a-z0-9]+','-',row[1].lower()).strip('-')}", row[2], now, now) for row in rows],
                )
            concepts = database.execute(
                "SELECT id,local_id FROM clinical_concept WHERE domain=%s AND local_id LIKE %s",
                (domain, prefix + "-%"),
            ).fetchall()
            concept_ids = {row["local_id"] if isinstance(row, dict) else row[1]: row["id"] if isinstance(row, dict) else row[0] for row in concepts}
            with database.cursor() as cursor:
                cursor.executemany(
                    """INSERT INTO clinical_concept_coding(concept_id,system_key,system_uri,code,display,version,is_preferred,terminology_entry_id,created_at,updated_at)
                       VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s,%s)
                       ON CONFLICT(concept_id,system_key,code) DO UPDATE SET display=excluded.display,version=excluded.version,
                         terminology_entry_id=excluded.terminology_entry_id,is_preferred=1,updated_at=excluded.updated_at""",
                    [(concept_ids[f"{prefix}-{re.sub(r'[^a-z0-9]+','-',row[1].lower()).strip('-')}"], coding_system,
                      row[3], row[1], row[2], row[4], row[0], now, now) for row in rows],
                )
            totals[domain] = len(rows)
    return totals


def parser():
    root = argparse.ArgumentParser()
    root.add_argument("command", choices=("public-baseline","icd10who","icd9cm","ucum","generic","snomed-rf2","tmt","tmt-map","materialize-icd-masters"))
    root.add_argument("--database-url", default=os.getenv("FLORA_DATABASE_URL"))
    root.add_argument("--source")
    root.add_argument("--system")
    root.add_argument("--system-uri")
    root.add_argument("--edition")
    root.add_argument("--version")
    root.add_argument("--release-date")
    root.add_argument("--domain", choices=("diagnosis","procedure","observation","medication","unit"))
    root.add_argument("--code-column", default="code")
    root.add_argument("--display-column", default="display")
    root.add_argument("--thai-column", default="display_th")
    root.add_argument("--parent-column", default="parent_code")
    root.add_argument("--delimiter")
    root.add_argument("--encoding", default="utf-8-sig")
    return root


def main():
    args = parser().parse_args()
    if not args.database_url:
        raise SystemExit("FLORA_DATABASE_URL or --database-url is required")
    with psycopg.connect(args.database_url) as database:
        if args.command in {"public-baseline","icd10who"}:
            entries = who_icd10_entries(args.source or WHO_ICD10_URL)
            import_release(database,system="ICD_10_WHO",system_uri="http://hl7.org/fhir/sid/icd-10",edition="WHO International",version="2019-covid-expanded",
                release_date="2020-03-22",source_uri=args.source or WHO_ICD10_URL,license_name="CC BY-ND 3.0 IGO",license_uri="https://creativecommons.org/licenses/by-nd/3.0/igo/",entries=entries)
            sync_icd10_compatibility(database,entries)
            print(f"WHO ICD-10 2019: {len(entries)} diagnoses")
        if args.command in {"public-baseline","icd9cm"}:
            entries = icd9_entries(args.source or CMS_ICD9_URL)
            import_release(database,system="ICD_9_CM",system_uri="http://hl7.org/fhir/sid/icd-9-cm",edition="CM Volume 3",version="32",
                release_date="2014-10-01",source_uri=args.source or CMS_ICD9_URL,license_name="US Government work",license_uri="https://www.cms.gov/",entries=entries)
            sync_icd9_compatibility(database,entries)
            print(f"ICD-9-CM Volume 3: {len(entries)} procedures")
        if args.command in {"public-baseline","ucum"}:
            entries = ucum_entries(args.source or UCUM_URL)
            import_release(database,system="UCUM",system_uri="http://unitsofmeasure.org",edition="UCUM",version="2.2",
                release_date="2024-06-17",source_uri=args.source or UCUM_URL,license_name="UCUM License 1.1",license_uri="https://ucum.org/license",entries=entries)
            print(f"UCUM 2.2: {len(entries)} units")
        if args.command == "generic":
            required = (args.system,args.system_uri,args.edition,args.version,args.domain,args.source)
            if not all(required): raise SystemExit("generic requires --system --system-uri --edition --version --domain --source")
            entries = generic_entries(args)
            import_release(database,system=args.system,system_uri=args.system_uri,edition=args.edition,version=args.version,
                release_date=args.release_date,source_uri=args.source,license_name="Hospital supplied",license_uri="",entries=entries)
            if args.system in {"ICD_10","ICD_10_TM","ICD_10_CM","ICD_10_WHO"}:
                sync_icd10_compatibility(database,entries)
            print(f"{args.system} {args.version}: {len(entries)} entries")
        if args.command == "snomed-rf2":
            if not all((args.source,args.edition,args.version)): raise SystemExit("snomed-rf2 requires --source --edition --version")
            entries = snomed_entries(args.source)
            import_release(database,system="SNOMED_CT",system_uri="http://snomed.info/sct",edition=args.edition,version=args.version,
                release_date=args.release_date,source_uri=args.source,license_name="SNOMED CT Affiliate License",license_uri="https://www.snomed.org/get-snomed",entries=entries)
            print(f"SNOMED CT {args.version}: {len(entries)} diagnosis/procedure concepts")
        if args.command == "tmt":
            if not all((args.source,args.version)): raise SystemExit("tmt requires --source --version")
            entries = tmt_entries(args)
            import_release(database,system="TMT",system_uri=TMT_URI,edition=args.edition or "Thailand",version=args.version,
                release_date=args.release_date,source_uri=args.source,license_name="TMT (THIS) terms of use",license_uri="https://www.this.or.th/",entries=entries)
            print(f"TMT {args.version}: {len(entries)} medication concepts")
        if args.command == "tmt-map":
            if not args.source: raise SystemExit("tmt-map requires --source")
            linked, missing = map_tmt(database, args.source, args.encoding)
            print(f"TMT mappings: {linked} linked, {len(missing)} not found: {', '.join(missing[:20])}")
        if args.command in {"public-baseline", "materialize-icd-masters"}:
            totals = materialize_icd_masters(database)
            print(f"Flora ICD masters: {totals.get('diagnosis', 0)} diagnoses, {totals.get('procedure', 0)} procedures")


if __name__ == "__main__":
    main()
