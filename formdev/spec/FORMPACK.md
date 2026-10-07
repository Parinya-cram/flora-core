# Form packages — `*.formpack` (Phase 3.9)

A formpack is a zip containing one **published** form version and everything needed to use it in a
standalone or intranet installation.

```
manifest.json            format "flora.formpack/1", form_id, schema_version, title,
                         checksum (definition SHA-256), style_ids, font_ids, files {path: sha256}
form.json                the definition (flora.form/1)
styles/<style_id>.json   style registry entries referenced by the form
fonts/<font_id>.json     font metadata (font binaries ship with the client bundle)
lookups/<lookup_id>.json lookup tables the form reads (Phase 2.3); manifest lists them as lookup_ids
assets/<path>            images and other static files used by the form
seed/records.json        optional seed records (record_id, schema_version, status, data)
```

## Guarantees

- **Deterministic**: sorted entries and fixed timestamps; the same input produces byte-identical files.
- **Verified before install**: every file's SHA-256 must match the manifest, no unlisted files,
  no path traversal (`..`, absolute paths), size limits (20 MB pack, 500 entries), and the definition
  checksum must match. A failed check installs nothing.
- **Atomic install** in one transaction: registry entries missing on the host are installed (existing
  ones are kept and reported as `unchanged` / `kept_existing`), the version is installed as published,
  assets are stored, seed records are created once (`skipped` on re-install).
- **Lookup tables** (Phase 2.3): exporting a form whose lookup is not registered is refused
  (`lookup_not_found`, 409). On install a packaged table is validated; it replaces a host table only
  when its version is higher (`installed` / `upgraded`), so an imported full dataset is never
  overwritten by an older or sample copy (`unchanged` / `kept_existing`).
- **Immutable versions**: re-installing the same version is a no-op; the same version with different
  content is refused (`version_conflict`).
- **Upgrades**: installing `v2` after `v1` makes v1 records readable as v2 through the migration in `v2`.

## Commands

```bash
# Build the example packs (deterministic) into formdev/packs/
PYTHONPATH=services/flora-api python3 formdev/scripts/build_example_packs.py

# Export / install over HTTP (administrator)
curl -H "X-FLORA-Session: $TOKEN" -o form.formpack http://HOST/api/formdev/forms/patient_assessment/package
curl -H "X-FLORA-Session: $TOKEN" --data-binary @form.formpack http://HOST/api/formdev/packages
```

The Canopy Form Dev page offers the same export/import in its Design panel.
