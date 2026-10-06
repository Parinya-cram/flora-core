# Source provenance

## Hidro

`parsers/ge/carestation/parser.py`, `parsers/ge/dri/parser.py`,
`parsers/bbraun/bcc/parser.py`, `parsers/hl7/hidro.py`, their shared
helpers, mapping files, and synthetic reference fixtures are adapted from the
user-supplied `C:\Users\JK\Hidro` source tree, specifically `service/ge750`,
`service/geaisyscs2`, `service/gebx50`, `service/ges5`, `service/bbraunbcc`,
`service/gehl7`, and the HL7 aliases in `service/db.js`.

Copyright (c) 2026 Hidro contributors. Distributed under the MIT License;
the original license is included as `LICENSES/Hidro-MIT.txt`.

The Flora rewrite separates transport from parsing, adds bounded buffering and
strict validation, maps observations to the gateway contract, and identifies
specific monitors and pump addresses. Source compatibility differences are
documented in `flora-gateway/HIDRO.md`. No Hidro databases, captures, desktop
application, or Node.js runtime are bundled in the parser image.

## IACS M540

`parsers/draeger/iacs_m540/blocks.py`, `parsers/draeger/iacs_m540/flora_mapping.json`, and the synthetic
test fixture were adapted from the user's local `C:\Users\JK\vector` tree:

- `src/vector_edge/adapters/iacs_m540.py`
- `config/mappings/iacs-m540-v1.json`
- `config/fixtures/iacs-m540-numeric.hex`
- `iacs-m540/iacs-m540-gw.rb` (transport behavior reference)

The decoder and numeric mapping originate from Vector's legacy IACS port.
The Flora adaptation removes Vector's outbox/contracts dependency, emits Flora
observations, validates opaque block bounds, and filters by monitor source IP.
No upstream license was present in the supplied IACS files. This notice does
not assign them a new license or establish redistribution rights.

## MEDIBUS

`parsers/draeger/medibus/parser.py`, `parsers/draeger/medibus/flora_mapping.json`,
and `parsers/draeger/medibus/device_parameters.json` are adapted from the
framing, command sequence, and code tables in:

`C:\Users\JK\vector\medibus\VSCaptureDrgVent-master\VSCaptureDrgVent-master\Class1.cs`
and `Class2.cs`.

Original: VitalSignsCaptureDraegerVent v1.003 / VSCaptureDrgVent.
Copyright (C) 2017-20 John George K., xeonfusion@users.sourceforge.net.

These adapted files are distributed under the GNU Lesser General Public License,
version 3 or (at your option) any later version. They are provided without any
warranty, including merchantability or fitness for a particular purpose.
The license texts are included in `LICENSES/LGPL-3.0.txt` and `LICENSES/GPL-3.0.txt`.

Flora changes translate the serial processing into a Python parser, route I/O
through Kafka, bound frame buffers, implement polling timeouts, and normalize
selected measurements to Flora units. This port excludes the source program's
waveform acquisition, CSV export, and MQTT publishing. No VSCapture binaries or
thalas application code are bundled.
