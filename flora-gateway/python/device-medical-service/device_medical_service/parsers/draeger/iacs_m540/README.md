# Dräger M540 / IACS

- Parser name in config: `iacs_m540`.
- Device types: `draeger-iacs-m540`.
- Transport: Passive UDP multicast.

`parser.py` selects the source monitor and maps observations. `blocks.py` decodes binary IACS blocks; `flora_mapping.json` holds numeric mappings.

## Configuration

Edit the matching pod in [gateway.draeger.toml](../../../../../../config/gateway.draeger.toml)
and device record in [instances.draeger.json](../../../../../../config/instances.draeger.json).
Model defaults are registered in Haber's catalog. See the
[configuration guide](../../../../../../CONFIGURATION.md) for loading these files and
[protocol details](../../../../../../DRAEGER.md) for options and supported scope.

## Tests and development

From `flora-gateway/python/device-medical-service`:

```powershell
python -m pytest -q tests/draeger/iacs_m540
```

The tests mirror this folder; shared synthetic fixtures are in `tests/fixtures`.
Read [DEVELOPMENT.md](../../../../../../DEVELOPMENT.md) for the parser contract, data flow,
and registration checklist.

All decoded numeric fields are preserved separately with unverified names/units left null.
See [Dräger parameter guide](../../../../../../DRAEGER-PARAMETERS.md) for storage and migration.
