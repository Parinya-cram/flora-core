# Gateway developer guide

Start here when changing or adding a device integration. Connection setup is in
[CONFIGURATION.md](CONFIGURATION.md); this guide explains where the code lives.

## Follow the data

1. A Rust controller opens a serial port or network connection and publishes a
   `RawFrame` on `gw.raw.<pod>`.
2. The Python runtime loads the configured parser from `parsers/__init__.py`.
   One parser instance handles one registered device.
3. The parser checks protocol framing, decodes values, and creates observations.
   Its polling commands and replies go back through `gw.cmd.<pod>`.
4. Rust collector/publisher services store or forward the observations.

Device-specific decoding belongs in the protocol folder. Shared connection I/O
and reconnect behavior belong in `rust/crates/serial-controller` or
`rust/crates/socket-controller`. Kafka and process lifecycle belong in
`python/device-medical-service/device_medical_service/__main__.py`.

## Protocol folders

Under `python/device-medical-service/device_medical_service/`:

```text
parsers/
  __init__.py                  # Registry: config name -> parser class
  shared/
    base.py                    # Parser contract and observation construction
    helpers.py                 # Mapping loading and numeric validation
  draeger/
    iacs_m540/
      parser.py                # M540 observation mapping and source selection
      blocks.py                # IACS binary block decoder
      flora_mapping.json
      README.md
    medibus/
      device_parameters.json  # Legacy definitions + document evidence
      parser.py                # MEDIBUS framing, handshake, polling, decoding
      flora_mapping.json
      README.md
  ge/
    carestation/
      parser.py                # COM 1.2: Carestation 750 and active Aisys profile
      parameters.json
      README.md
    dri/
      parser.py                # DRI: S/5, Bx50, legacy Aisys profiles
      README.md
  bbraun/
    bcc/
      parser.py                # BCC framing, polling, ACK and pump selection
      parameters.json
      README.md
  hl7/
    parser.py                  # Shared HL7 v2 decoding
    hidro.py                   # Hidro alias/segment-repair profile
    parameters.json            # Hidro aliases
    README.md
  generic/
    ascii_kv/
      parser.py
      README.md
    json_fields/
      parser.py
      README.md
```

Dräger original fields use `gw.measurements` independently of `gw.obs`; see
[DRAEGER-PARAMETERS.md](DRAEGER-PARAMETERS.md) for storage and migration.

Each protocol folder has a README with its device types, configuration files,
and test command. `parameters.json`, where present, belongs to that protocol.
GE DRI's field offsets and conversions remain in its parser because they are
part of the binary format. Generic parsers receive mappings through options.

Models that speak the same protocol share an implementation. Select their
differences through catalog defaults and instance options, rather than copying
the driver into another model folder. Shared HL7 lives outside vendor folders
because multiple vendors use it.

## Find the matching configuration and tests

| Protocol folder | Stable parser name | Starter configuration |
| --- | --- | --- |
| `draeger/iacs_m540` | `iacs_m540` | `config/gateway.draeger.toml`, `config/instances.draeger.json` |
| `draeger/medibus` | `medibus` | Dräger files above |
| `ge/carestation` | `ge_carestation` | `config/gateway.hidro.toml`, `config/instances.hidro.json` |
| `ge/dri` | `ge_dri` | Hidro files above |
| `bbraun/bcc` | `bbraun_bcc` | Hidro files above |
| `hl7` | `hl7v2`, `hidro_hl7` | Demo files for generic HL7; Hidro files for its profile |
| `generic/ascii_kv` | `ascii_kv` | `config/gateway.toml`, `config/instances.json` |
| `generic/json_fields` | `json_fields` | Demo files above |

Deployment files stay together in `config/`: a site can use several protocols
in one controller configuration. Parser names and device type IDs have not
changed with this folder reorganization. Internal Python imports now use the
new package paths.

`python/device-medical-service/tests/` mirrors the protocol tree. For example,
`tests/ge/dri/test_dri.py` exercises `parsers/ge/dri/parser.py`.
`tests/test_runtime.py` checks shared Kafka command/observation routing.
Synthetic fixtures live in `tests/fixtures/`; the Hidro reference generator
remains `tests/generate_hidro_fixtures.cjs` because it covers several protocols.

From `python/device-medical-service`:

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q tests/ge/dri
python -m pytest -q tests
```

From `flora-gateway`, validate edited profiles without connecting hardware:

```powershell
python scripts/validate_config.py config/gateway.hidro.toml config/instances.hidro.json
```

## Add or change a driver

1. Find the protocol folder and read its README. Check whether an existing
   protocol can support the model through options.
2. For a new protocol, create a package with `__init__.py`, `parser.py`, and
   `README.md` under its vendor (or a shared protocol folder such as `hl7`).
   Subclass `Parser` from `parsers.shared.base`; keep transport I/O out of it.
3. Implement `feed()` and, when needed, `poll()`. Queue immediate protocol
   replies in the driver and expose them through `drain_commands()`. Follow the existing drivers for
   bounded buffering, invalid-frame handling, and transport reconnect events.
4. Register the class in `parsers/__init__.py`, then add its parser/device type
   to `flora-canopy/haber/app/catalog.json`. Keep identifiers stable once used.
5. Add disabled connection and instance examples under `config/`, document
   options/units, and add any required source attribution and license.
6. Put synthetic protocol tests under the matching `tests/` folder. Cover
   checksums, partial frames, units, unavailable values, and replies as relevant.
   Run the full parser suite and config validator before rebuilding the image.

See [HIDRO.md](HIDRO.md) and [DRAEGER.md](DRAEGER.md) for supported scope and
hardware-validation limitations of the imported drivers.
