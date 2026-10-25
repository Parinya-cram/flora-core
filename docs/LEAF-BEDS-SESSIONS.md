# One Leaf, several beds: sessions

A **session** is one patient's stay at one bed (or room), from start to transfer or discharge — the same word as
in [OR-JOURNEY.md](OR-JOURNEY.md). On a Leaf a session is an active case with a `bed_label`; its devices are the
case's device bindings ([live-stream/PROTOCOL.md](live-stream/PROTOCOL.md)).

- **One Leaf, several beds:** a Leaf (ward station) may run many sessions at once, one per bed.
- **Devices follow the patient:** devices are bound to the session (`case_device_binding`), not to the Leaf; they are
  released at discharge, archive or transfer.
- **One device, several Leafs:** a device may be watched by several Leafs when bound `shared`. The gateway allows it
  only when the device's `leaf_id` on the gateway is empty or that Leaf (PROTOCOL.md, binding rules).

## Where the beds come from

Canopy → Topology → Physical:

- **Primary bed:** `canopy_leaf_assignment`.
- **Further beds:** `canopy_leaf_bed` — a bed is served by at most one Leaf.
- **Devices at a bed:** Canopy → Devices: a registered device with `bed_id` and a gateway link
  (`gateway_id`, `gateway_device_id`).

The ward exchange (`POST /api/sync/v1/ward`) sends each Leaf `my_beds`: its beds, primary first, each with its
devices (`case_transfer.leaf_beds`). The Leaf stores it with the rest of the ward state, and `GET /api/ward/overview`
returns it as `beds`. A Leaf with no beds in Canopy gets `[]`, and its Ward page is as before.

## Leaf Ward page: the bed board

`frontend/src/components/ward/BedBoard.tsx`, shown on the Active tab when `beds` is not empty.

- **Free bed:** tap → the start page opens with that bed's name as `bed_label` and its devices preset as exclusive
  bindings (`components/ward/bedSession.ts`).
  - The mapping uses this Leaf's gateway link to each device's gateway.
  - Devices of a gateway without a link are named in a notice instead.
- **Occupied bed:** tap → opens the session (its case).
  - A case belongs to the bed whose name or code equals its `bed_label`, the same rule as Canopy's
    `or_schedule.bed_cases`.
  - Active cases that match no bed are listed under "Sessions without a bed".
- **Device chips:**
  - green: ready;
  - amber: online, but the Leaf has no link to its gateway, or the device is set for another Leaf;
  - red: offline.

## How Leaf and gateway talk

The Leaf always connects out to the gateway; it never waits for the gateway to call it.

- **Live (1 s):**
  - `leaf-live` (Leaf backend) opens a WebSocket to the gateway's `stream-hub` (`/stream/v1`) and binds each
    session's devices.
  - The gateway then pushes one chunk per device per second.
  - The Leaf stores the chunk, acks it, then fans it out to open screens.
  - It runs whether or not a screen is open. After a disconnect, the hub replays from Kafka.
- **Minutes:** the Leaf also pulls `/data-api` (minute values) to fill charts and anything before the stream.

The install files the appliance hands out (`flora-canopy/haber/app/install/{leaf,gateway}`) run `leaf-live` and
`stream-hub`. The Windows app runs them as processes (`electron/native/runtime.cjs`, `gateway.cjs`).
