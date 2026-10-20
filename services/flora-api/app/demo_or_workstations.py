"""Demo: the OR Suite workstations for the OR → Recovery journey, in one Canopy account.

    docker exec flora-canopy-canopy-api-1 python -m app.demo_or_workstations [account]   (default: kcmh)

Makes sure the OR Suite care unit has Operating Room 1 / 2 (OR rooms, one bed each) and the OR1 Recovery
room (two beds), marks the room types for the OR schedule, and assigns each demo Leaf to its bed once it has
synced (registered) with Canopy. Safe to run again.
"""
from __future__ import annotations

import sys

from . import tenancy
from .database import open_pool, pool
from .routes.fleet_control import ensure_location, write_assignment

WARD = "OR Suite"
ROOMS = [("Operating Room 1", "or", ["OR-1"]), ("Operating Room 2", "or", ["OR-2"]), ("OR1 Recovery", "recovery", ["Recovery-1", "Recovery-2"])]
# One Recovery Leaf for the room; until multi-bed Leafs exist it is assigned to the first bed.
LEAVES = {"OR-1": "leaf-or-01", "OR-2": "leaf-or-02", "Recovery-1": "leaf-recovery-01"}


def main(argv: list[str]) -> int:
    code = argv[0] if argv else "kcmh"
    open_pool()
    account = tenancy.by_code(code) if tenancy.MULTI_ACCOUNT else None
    if tenancy.MULTI_ACCOUNT and account is None:
        print(f"no active account '{code}'", file=sys.stderr)
        return 1
    with tenancy.using(account) if account else _nothing():
        with pool.connection() as database:
            tenancy.scope_connection(database)
            unit = database.execute("SELECT id FROM canopy_location WHERE kind='care_unit' AND lower(name)=lower(%s) LIMIT 1",
                                    (WARD,)).fetchone()
            if unit is None:
                print(f"care unit '{WARD}' not found in account {code}", file=sys.stderr)
                return 1
            reference = database.execute(
                "SELECT desired_config FROM canopy_leaf_assignment WHERE leaf_id='leaf-or-01'").fetchone()
            config = (reference or {}).get("desired_config") or {}
            settings = {"timezone": config.get("timezone") or "Asia/Bangkok", "date_format": config.get("dateFormat") or "DD/MM/YYYY",
                        "time_format": config.get("timeFormat") or "24h"}
            for room_name, room_type, beds in ROOMS:
                room = ensure_location(database, unit["id"], "room", room_name)
                database.execute("UPDATE canopy_location SET room_type=%s WHERE id=%s", (room_type, room))
                for bed_name in beds:
                    bed = ensure_location(database, room, "bed", bed_name)
                    leaf_id = LEAVES.get(bed_name)
                    if leaf_id is None:
                        continue
                    current = database.execute("SELECT bed_location_id FROM canopy_leaf_assignment WHERE leaf_id=%s", (leaf_id,)).fetchone()
                    if current and current["bed_location_id"] == bed:
                        print(f"{bed_name}: {leaf_id} already here")
                    elif not database.execute("SELECT 1 FROM sync_leaf_node WHERE leaf_id=%s", (leaf_id,)).fetchone():
                        print(f"{bed_name}: {leaf_id} has not synced yet; run this again once it is up")
                    elif database.execute("SELECT 1 FROM canopy_leaf_assignment WHERE bed_location_id=%s AND leaf_id<>%s", (bed, leaf_id)).fetchone():
                        print(f"{bed_name}: another Leaf is assigned to this bed; left as it is")
                    else:
                        write_assignment(database, leaf_id, bed, settings)
                        print(f"{bed_name}: assigned {leaf_id}")
    return 0


class _nothing:
    def __enter__(self):
        return None

    def __exit__(self, *_):
        return False


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
