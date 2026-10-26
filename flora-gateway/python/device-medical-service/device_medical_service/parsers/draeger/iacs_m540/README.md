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

## Pod parser and waveforms

- The device type is flagged `demux`: the Gateway runs one parser container per pod
  (`flora-gw-parser-pod-<pod>`, `POD_DEMUX=1`) with one parser instance per M540, chosen
  by `options.source_ip`. A monitor with no instance is reported once a minute on `gw.logs`
  (`unregistered_monitor`).
- Waveform blocks are published on `gw.wave` with `t0` = the frame's ingress time.
  - **Unverified:** the sample rate. The block tag (200/100/50) is taken as Hz until it is
    checked against real M540 captures.
  - `wave_rate_hz` overrides the rate per waveform key (`"31-1"`) or per tag (`"200"`).
  - `wave_channels` names a key, e.g. `{"1-1": "ecg"}`; otherwise the channel is the key.
  - `publish_waves: false` turns waveforms off.

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
