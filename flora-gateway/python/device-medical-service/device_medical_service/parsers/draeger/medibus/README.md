# Dräger MEDIBUS.X

- Parser name in config: `medibus`.
- Device types: `draeger-medibus`.
- Transport: Serial RS-232.

`parser.py` owns framing, checksums, handshake, polling, replies, and decoding. `flora_mapping.json` holds Flora conversions. `device_parameters.json` holds the separate legacy source definitions.

## Configuration

Edit the matching pod in [gateway.draeger.toml](../../../../../../config/gateway.draeger.toml)
and device record in [instances.draeger.json](../../../../../../config/instances.draeger.json).
Model defaults are registered in Haber's catalog. See the
[configuration guide](../../../../../../CONFIGURATION.md) for loading these files and
[protocol details](../../../../../../DRAEGER.md) for options and supported scope.

## Tests and development

From `flora-gateway/python/device-medical-service`:

```powershell
python -m pytest -q tests/draeger/medibus
```

The tests mirror this folder; shared synthetic fixtures are in `tests/fixtures`.
Read [DEVELOPMENT.md](../../../../../../DEVELOPMENT.md) for the parser contract, data flow,
and registration checklist.

Original fields and migration: [Dräger parameter guide](../../../../../../DRAEGER-PARAMETERS.md).
