# Flora iCIS — notes for AI assistants

- Device settings per device type (parser, controller, options, connection defaults) are maintained in
  **Root → Device library** and reach gateways through each hospital's appliance — not by editing
  `flora-gateway/device-types.json` (that file only seeds the library). How to add or import entries (API,
  curl, CSV): [docs/DEVICE-LIBRARY.md](docs/DEVICE-LIBRARY.md).
