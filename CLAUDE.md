# Flora iCIS — notes for AI assistants

- Device settings per device type (parser, controller, options, connection defaults) are maintained in
  **Root → Device library** and reach gateways through each hospital's appliance — not by editing
  `flora-gateway/device-types.json` (that file only seeds the library). How to add or import entries (API,
  curl, CSV): [docs/DEVICE-LIBRARY.md](docs/DEVICE-LIBRARY.md).
- A Leaf runs several beds at once; each patient's stay at a bed is a **session** (an active case with a
  `bed_label` and its device bindings). Beds come from Canopy (Topology → Physical), devices per bed from Canopy
  Devices; the Leaf Ward page shows them as a bed board. See [docs/LEAF-BEDS-SESSIONS.md](docs/LEAF-BEDS-SESSIONS.md).
