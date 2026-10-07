"""Form packages (``*.formpack``): a self-contained, verifiable bundle of one published
form version that can be installed in a standalone or intranet environment.

Layout (zip)::

    manifest.json          format, form id/version, definition checksum, sha256 of every file
    form.json              the published definition
    styles/<style_id>.json style registry entries the form uses
    fonts/<font_id>.json   font metadata (binaries are bundled with the client)
    lookups/<id>.json      lookup tables the form reads (Phase 2.3), so offline clients offer the same options
    assets/<path>          images and other static files
    seed/records.json      optional seed records

Building is deterministic (sorted entries, fixed timestamps) so the same input always
produces byte-identical packages.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import posixpath
import zipfile
from typing import Any

from .definition import canonical_json, checksum
from .errors import FormDevError
from .logic.lookup import lookup_ids
from .repositories import RecordRepository, SchemaRepository, StyleRepository, now_ms
from .lookups import validate_lookup
from .styles import pack_registry

FORMAT = "flora.formpack/1"
MAX_PACK_BYTES = 20 * 1024 * 1024
MAX_ENTRIES = 500
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MEDIA_TYPES = {
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".json": "application/json", ".txt": "text/plain",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".pdf": "application/pdf",
}


def media_type(path: str) -> str:
    return MEDIA_TYPES.get(posixpath.splitext(path)[1].lower(), "application/octet-stream")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _safe_asset_path(path: str) -> str:
    normalized = posixpath.normpath(path.replace("\\", "/"))
    if normalized.startswith(("/", "../")) or normalized in (".", "..") or ".." in normalized.split("/"):
        raise FormDevError("invalid_formpack", f"Unsafe asset path '{path}'")
    return normalized


def pack(
    definition: dict[str, Any],
    styles: list[dict[str, Any]],
    fonts: list[dict[str, Any]],
    assets: dict[str, bytes] | None = None,
    seed_records: list[dict[str, Any]] | None = None,
    lookups: list[dict[str, Any]] | None = None,
) -> bytes:
    files: dict[str, bytes] = {"form.json": _json_bytes(definition)}
    for style in styles:
        files[f"styles/{style['style_id']}.json"] = _json_bytes({"style_id": style["style_id"], "version": style["version"], "definition": style["definition"]})
    for font in fonts:
        files[f"fonts/{font['font_id']}.json"] = _json_bytes({"font_id": font["font_id"], "metadata": font["metadata"]})
    for lookup in lookups or []:
        files[f"lookups/{lookup['lookup_id']}.json"] = _json_bytes({key: lookup[key] for key in ("lookup_id", "version", "metadata", "entries")})
    for path, content in sorted((assets or {}).items()):
        files[f"assets/{_safe_asset_path(path)}"] = content
    if seed_records:
        files["seed/records.json"] = _json_bytes(seed_records)
    manifest = {
        "format": FORMAT,
        "form_id": definition["form_id"],
        "schema_version": definition["schema_version"],
        "title": definition["title"],
        "checksum": checksum(definition),
        "style_ids": sorted(style["style_id"] for style in styles),
        "font_ids": sorted(font["font_id"] for font in fonts),
        **({"lookup_ids": sorted(lookup["lookup_id"] for lookup in lookups)} if lookups else {}),
        "files": {path: hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())},
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, content in [("manifest.json", _json_bytes(manifest)), *sorted(files.items())]:
            info = zipfile.ZipInfo(path, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)
    return buffer.getvalue()


def export_formpack(
    schemas: SchemaRepository,
    styles: StyleRepository,
    form_id: str,
    schema_version: int | None = None,
    seed_records: list[dict[str, Any]] | None = None,
) -> bytes:
    row = schemas.get_version(form_id, schema_version) if schema_version else schemas.latest_published(form_id)
    if row["status"] == "draft":
        raise FormDevError("form_not_published", "Only published versions can be packaged", 409)
    definition = row["definition"]
    style_rows, font_rows = pack_registry(definition, styles.get_style, styles.get_font)
    adapter = schemas.adapter
    assets = {
        item["path"]: base64.b64decode(adapter.get_asset(form_id, item["path"])["content_b64"])  # type: ignore[index]
        for item in adapter.list_assets(form_id)
    }
    lookup_rows = []
    for lookup_id in sorted(lookup_ids(definition)):
        row = adapter.get_lookup(lookup_id)
        if row is None:
            raise FormDevError("lookup_not_found", f"The form reads lookup '{lookup_id}', which is not in the registry", 409)
        lookup_rows.append(row)
    return pack(definition, style_rows, font_rows, assets, seed_records, lookup_rows)


def read_formpack(data: bytes) -> dict[str, Any]:
    """Open and verify a package without touching storage."""
    if len(data) > MAX_PACK_BYTES:
        raise FormDevError("invalid_formpack", "Package is too large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise FormDevError("invalid_formpack", "Package is not a valid zip archive") from None
    with archive:
        names = archive.namelist()
        if len(names) > MAX_ENTRIES or "manifest.json" not in names:
            raise FormDevError("invalid_formpack", "Package has no manifest or too many files")
        if sum(info.file_size for info in archive.infolist()) > MAX_PACK_BYTES * 4:
            raise FormDevError("invalid_formpack", "Package expands beyond the allowed size")
        try:
            manifest = json.loads(archive.read("manifest.json"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise FormDevError("invalid_formpack", "manifest.json is not valid JSON") from None
        if manifest.get("format") != FORMAT or not isinstance(manifest.get("files"), dict):
            raise FormDevError("invalid_formpack", f"Unsupported package format '{manifest.get('format')}'")
        listed = set(manifest["files"])
        present = set(names) - {"manifest.json"}
        if listed != present:
            raise FormDevError("invalid_formpack", "Package contents do not match the manifest", details={"unlisted": sorted(present - listed), "missing": sorted(listed - present)})
        files: dict[str, bytes] = {}
        for path in sorted(listed):
            if path.startswith("assets/"):
                _safe_asset_path(path[len("assets/"):])
            content = archive.read(path)
            if hashlib.sha256(content).hexdigest() != manifest["files"][path]:
                raise FormDevError("invalid_formpack", f"Checksum mismatch for {path}")
            files[path] = content
    definition = json.loads(files["form.json"])
    if checksum(definition) != manifest.get("checksum"):
        raise FormDevError("invalid_formpack", "form.json does not match the manifest checksum")
    return {
        "manifest": manifest,
        "definition": definition,
        "styles": [json.loads(content) for path, content in files.items() if path.startswith("styles/")],
        "fonts": [json.loads(content) for path, content in files.items() if path.startswith("fonts/")],
        "lookups": [json.loads(content) for path, content in files.items() if path.startswith("lookups/")],
        "assets": {path[len("assets/"):]: content for path, content in files.items() if path.startswith("assets/")},
        "seed_records": json.loads(files["seed/records.json"]) if "seed/records.json" in files else [],
    }


def install_formpack(
    data: bytes,
    schemas: SchemaRepository,
    styles: StyleRepository,
    records: RecordRepository,
    user: str,
) -> dict[str, Any]:
    package = read_formpack(data)
    definition = package["definition"]
    adapter = schemas.adapter
    summary: dict[str, Any] = {"form_id": definition["form_id"], "schema_version": definition["schema_version"], "styles": {}, "fonts": {}, "lookups": {}}
    with adapter.transaction():
        # Fonts first: styles are validated against the font registry.
        for font in package["fonts"]:
            existing = adapter.get_font(font["font_id"])
            if existing is None:
                styles.save_font(font["font_id"], font["metadata"])
                summary["fonts"][font["font_id"]] = "installed"
            else:
                summary["fonts"][font["font_id"]] = "unchanged" if canonical_json(existing["metadata"]) == canonical_json(font["metadata"]) else "kept_existing"
        for style in package["styles"]:
            existing = adapter.get_style(style["style_id"])
            if existing is None:
                styles.save_style(style["style_id"], style["definition"], int(style.get("version", 1)))
                summary["styles"][style["style_id"]] = "installed"
            else:
                same = canonical_json(existing["definition"]) == canonical_json(style["definition"])
                summary["styles"][style["style_id"]] = "unchanged" if same else "kept_existing"
        # Lookups before seed records, which are evaluated against them. A newer packaged version replaces an
        # older one; an equal or newer local table (for example an imported full dataset) is kept.
        for lookup in package["lookups"]:
            issues = validate_lookup(lookup.get("lookup_id"), lookup.get("metadata"), lookup.get("entries"))
            if issues:
                raise FormDevError("invalid_formpack", f"Lookup '{lookup.get('lookup_id')}' is not valid", 422, [issue.as_dict() for issue in issues])
            existing = adapter.get_lookup(lookup["lookup_id"])
            if existing is not None and int(existing["version"]) >= int(lookup.get("version", 1)):
                same = canonical_json(existing["entries"]) == canonical_json(lookup["entries"])
                summary["lookups"][lookup["lookup_id"]] = "unchanged" if same else "kept_existing"
                continue
            adapter.save_lookup({"lookup_id": lookup["lookup_id"], "version": int(lookup.get("version", 1)), "metadata": lookup["metadata"],
                                 "entries": lookup["entries"], "updated_at": now_ms(), "updated_by": user})
            summary["lookups"][lookup["lookup_id"]] = "installed" if existing is None else "upgraded"
        summary["definition"] = schemas.install_published(definition, user)
        for path, content in package["assets"].items():
            adapter.save_asset({
                "form_id": definition["form_id"], "path": path, "media_type": media_type(path),
                "sha256": hashlib.sha256(content).hexdigest(), "size": len(content),
                "content_b64": base64.b64encode(content).decode("ascii"), "created_at": now_ms(),
            })
        summary["assets"] = len(package["assets"])
        created = skipped = 0
        for seed in package["seed_records"]:
            if records.get_raw(seed["record_id"]) is not None:
                skipped += 1
                continue
            records.create(
                definition["form_id"], seed["data"], user, status=seed.get("status", "draft"),
                record_id=seed["record_id"], schema_version=seed.get("schema_version", definition["schema_version"]),
                sync_id="formpack",
            )
            created += 1
        summary["seed_records"] = {"created": created, "skipped": skipped}
    return summary
