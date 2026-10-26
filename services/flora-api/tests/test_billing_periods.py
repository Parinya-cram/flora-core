"""ICU daily billing (app/billing_periods.py): day windows, standing charges, device-days, estimate. No database.

    PYTHONPATH=. python3 -m pytest -q tests/test_billing_periods.py
"""
import importlib.util
import sys
import types
import unittest
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

if importlib.util.find_spec("psycopg") is None:  # a bare test venv: the functions tested here never touch the database
    for name in ("psycopg", "psycopg.types", "psycopg.types.json"):
        sys.modules[name] = types.ModuleType(name)
    sys.modules["psycopg"].Connection = object
    sys.modules["psycopg.types.json"].Jsonb = lambda value: value

from app import billing_periods as bp  # noqa: E402

BKK = ZoneInfo("Asia/Bangkok")
TZ = "Asia/Bangkok"
HOUR = 3_600_000


def at(day: int, hour: int, minute: int = 0, month: int = 10) -> int:
    return int(datetime(2026, month, day, hour, minute, tzinfo=BKK).timestamp() * 1000)


def item(code, basis="per_day", kind=None, price=100.0, active=1):
    return {"code": code, "group_code": "icu_daily", "name": code, "unit": "day", "qty_mode": "count",
            "unit_price": price, "charge_code": None, "charge_basis": basis, "device_kind": kind, "is_active": active}


ITEMS = [item("icu_bed_day", price=3000), item("icu_nursing_day", price=1500),
         item("icu_ventilator_day", "per_device_day", "ventilator", 2000),
         item("icu_infusion_pump_day", "per_device_day", "infusion_pump", 500),
         item("ds-syringe-10", "unit", price=5), item("icu_old", price=1, active=0)]


class PeriodsTest(unittest.TestCase):
    def test_day1_from_start_to_next_day_start(self):
        days = bp.periods({"start_time": at(26, 3), "discharge_time": None}, TZ, "07:00", at(27, 10))
        self.assertEqual([(d["period_start"], d["period_end"]) for d in days],
                         [(at(26, 3), at(26, 7)), (at(26, 7), at(27, 7)), (at(27, 7), at(28, 7))])
        self.assertEqual([d["day"] for d in days], [1, 2, 3])
        self.assertEqual([d["current"] for d in days], [False, False, True])

    def test_start_after_day_start_crosses_midnight(self):
        days = bp.periods({"start_time": at(26, 22, 30), "discharge_time": None}, TZ, "07:00", at(27, 2))
        self.assertEqual([(d["period_start"], d["period_end"]) for d in days], [(at(26, 22, 30), at(27, 7))])
        self.assertEqual(days[0]["date"], "2026-10-26")

    def test_midnight_day_start(self):
        days = bp.periods({"start_time": at(26, 23), "discharge_time": None}, TZ, "00:00", at(27, 1))
        self.assertEqual([(d["period_start"], d["period_end"]) for d in days], [(at(26, 23), at(27, 0)), (at(27, 0), at(28, 0))])

    def test_discharge_ends_the_list(self):
        days = bp.periods({"start_time": at(26, 8), "discharge_time": at(28, 7)}, TZ, "07:00", at(30, 12))
        self.assertEqual([d["period_start"] for d in days], [at(26, 8), at(27, 7)], "discharge on a day_start opens no new day")
        days = bp.periods({"start_time": at(26, 8), "discharge_time": at(28, 9)}, TZ, "07:00", at(30, 12))
        self.assertEqual(len(days), 3)
        self.assertFalse(any(d["current"] for d in days))

    def test_start_exactly_on_day_start(self):
        days = bp.periods({"start_time": at(26, 7), "discharge_time": None}, TZ, "07:00", at(26, 7, 5))
        self.assertEqual([(d["period_start"], d["period_end"]) for d in days], [(at(26, 7), at(27, 7))])

    def test_find_period_and_mode(self):
        days = bp.periods({"start_time": at(26, 3), "discharge_time": None}, TZ, "07:00", at(27, 10))
        self.assertEqual(bp.find_period(days, at(26, 7))["day"], 2)
        self.assertIsNone(bp.find_period(days, at(26, 8)))
        self.assertEqual(bp.billing_mode({"billing": {"template_id": None, "mode": "daily"}}), "daily")
        self.assertEqual(bp.billing_mode({"billing": {"template_id": "x"}}), "case")
        self.assertEqual(bp.billing_mode(None), "case")


class DeviceTest(unittest.TestCase):
    def test_kind(self):
        self.assertEqual(bp.device_kind("http-ventilator", "ICU bed 1 ventilator"), "ventilator")
        self.assertEqual(bp.device_kind("hl7-patient-monitor"), "monitor")
        self.assertEqual(bp.device_kind("draeger-iacs-m540"), "monitor")
        self.assertEqual(bp.device_kind("json-anesthesia-machine"), "anesthesia_machine")
        self.assertEqual(bp.device_kind(None, "B. Braun Perfusor"), "infusion_pump")
        self.assertIsNone(bp.device_kind("acme-t200", None))
        self.assertIsNone(bp.device_kind(None, None))

    def test_overlap(self):
        day = {"period_start": at(27, 7), "period_end": at(28, 7)}
        self.assertTrue(bp.overlaps({"bound_at": at(26, 8), "released_at": None}, day))
        self.assertTrue(bp.overlaps({"bound_at": at(26, 8), "released_at": at(27, 7, 1)}, day))
        self.assertFalse(bp.overlaps({"bound_at": at(26, 8), "released_at": at(27, 7)}, day), "released at the boundary")
        self.assertFalse(bp.overlaps({"bound_at": at(28, 7), "released_at": None}, day), "bound at the next boundary")
        self.assertTrue(bp.overlaps({"bound_at": at(28, 6), "released_at": at(28, 6, 30)}, day))


class StandingTest(unittest.TestCase):
    day = {"period_start": at(27, 7), "period_end": at(28, 7)}

    def test_rules_from_master_basis(self):
        codes = [r["item"]["code"] for r in bp.standing_rules(ITEMS, None)]
        self.assertEqual(codes, ["icu_bed_day", "icu_nursing_day", "icu_ventilator_day", "icu_infusion_pump_day"])

    def test_rules_from_template_standing(self):
        template = {"groups": [{"key": "icu", "name": "ICU", "items": [
            {"code": "icu_bed_day", "standing": True}, {"code": "ds-syringe-10", "qty": 4, "standing": True},
            {"code": "icu_nursing_day"}, {"code": "icu_old", "standing": True}]}]}
        rules = bp.standing_rules(ITEMS, template)
        self.assertEqual([(r["item"]["code"], r["qty"]) for r in rules], [("icu_bed_day", 1.0), ("ds-syringe-10", 4.0)],
                         "only flagged, active items; template qty")

    def test_device_day_needs_an_overlapping_device_of_that_kind(self):
        rules = bp.standing_rules(ITEMS, None)
        devices = [{"device_id": "vent-1", "kind": "ventilator", "bound_at": at(26, 8), "released_at": at(27, 12)},
                   {"device_id": "pump-1", "kind": "infusion_pump", "bound_at": at(28, 8), "released_at": None},
                   {"device_id": "mon-1", "kind": "monitor", "bound_at": at(26, 8), "released_at": None}]
        lines = bp.standing_for_period(rules, devices, self.day)
        self.assertEqual([(l["item_code"], l["qty"]) for l in lines],
                         [("icu_bed_day", 1), ("icu_nursing_day", 1), ("icu_ventilator_day", 1)])
        self.assertEqual(lines[2]["note"], "vent-1")
        self.assertTrue(all(l["source"] == "standing" for l in lines))
        next_day = {"period_start": at(28, 7), "period_end": at(29, 7)}
        codes = [l["item_code"] for l in bp.standing_for_period(rules, devices, next_day)]
        self.assertNotIn("icu_ventilator_day", codes)
        self.assertIn("icu_infusion_pump_day", codes)

    def test_one_device_day_per_device(self):
        rules = bp.standing_rules(ITEMS, None)
        devices = [{"device_id": f"pump-{n}", "kind": "infusion_pump", "bound_at": at(26, 8), "released_at": None} for n in (1, 2)]
        pump = [l for l in bp.standing_for_period(rules, devices, self.day) if l["item_code"] == "icu_infusion_pump_day"]
        self.assertEqual((pump[0]["qty"], pump[0]["note"]), (2, "pump-1, pump-2"))

    def test_unknown_kind_adds_nothing(self):
        rules = bp.standing_rules(ITEMS, None)
        lines = bp.standing_for_period(rules, [{"device_id": "x", "kind": None, "bound_at": 0, "released_at": None}], self.day)
        self.assertEqual([l["item_code"] for l in lines], ["icu_bed_day", "icu_nursing_day"])

    def test_manual_line_replaces_standing(self):
        standing = bp.standing_for_period(bp.standing_rules(ITEMS, None), [], self.day)
        manual = [{"item_code": "icu_nursing_day", "qty": 2, "source": "manual"}, {"item_code": "ds-syringe-10", "qty": 3, "source": "manual"}]
        merged = bp.merge(standing, manual)
        self.assertEqual([(l["item_code"], l["source"]) for l in merged],
                         [("icu_bed_day", "standing"), ("icu_nursing_day", "manual"), ("ds-syringe-10", "manual")])

    def test_generate_is_idempotent(self):
        """Running generate twice leaves the same lines (standing recomputed, manual kept once)."""
        store: dict[int, list] = {7: [{"item_code": "ds-syringe-10", "group_code": "disposable", "name": "Syringe", "qty": 3,
                                        "source": "manual", "unit_price": 5, "qty_mode": "count"}]}
        devices = [{"device_id": "vent-1", "kind": "ventilator", "bound_at": at(26, 8), "released_at": None}]

        def standing_lines(_db, _case, period, template=None, devices_=None):
            return bp.standing_for_period(bp.standing_rules(ITEMS, template), devices, period)

        def write_lines(_db, _case, order_id, lines, _now):
            store[order_id] = [dict(line) for line in lines]

        order = {"id": 7, **self.day}
        with mock.patch.object(bp, "standing_lines", standing_lines), mock.patch.object(bp, "write_lines", write_lines), \
                mock.patch.object(bp.billing, "order_lines", lambda _db, order_id: [dict(line) for line in store[order_id]]):
            first = bp.generate(None, 1, order, None, 0)
            again = bp.generate(None, 1, order, None, 0)
        self.assertEqual(first, again)
        self.assertEqual([l["item_code"] for l in store[7]],
                         ["icu_bed_day", "icu_nursing_day", "icu_ventilator_day", "ds-syringe-10"])


class EstimateTest(unittest.TestCase):
    def test_summary(self):
        windows = bp.periods({"start_time": at(26, 3), "discharge_time": None}, TZ, "07:00", at(28, 10))
        starts = [w["period_start"] for w in windows]  # 4 days: 26 03-07, 26-27, 27-28, 28-
        orders = {starts[0]: {"status": "submitted"}, starts[1]: {"status": "submitted"}, starts[3]: {"status": "draft"}}
        totals = {starts[0]: 4500.0, starts[1]: 6500.0, starts[3]: 100.0}
        previews = {starts[2]: 4500.0}
        result = bp.summarize(windows, orders, totals, previews, 4500.0, 2)
        self.assertEqual([d["status"] for d in result["days"]], ["closed", "closed", "open", "open"])
        self.assertEqual([d["source"] for d in result["days"]], ["order", "order", "standing_preview", "order"])
        self.assertEqual((result["closed_total"], result["open_total"], result["projected_to_today"]), (11000.0, 100.0, 4500.0))
        self.assertEqual(result["to_date_total"], 15600.0)
        self.assertEqual((result["projected_extra"], result["grand_total"]), (9000.0, 24600.0))

    def test_unpriced_and_no_extra(self):
        windows = bp.periods({"start_time": at(26, 8), "discharge_time": None}, TZ, "07:00", at(26, 9))
        result = bp.summarize(windows, {}, {}, {windows[0]["period_start"]: None}, None, 0)
        self.assertEqual((result["grand_total"], result["days"][0]["total"]), (0.0, 0.0))

    def test_total(self):
        self.assertEqual(bp.total([{"unit_price": 10, "qty": 2, "qty_mode": "count"}, {"unit_price": None, "qty": 1}]), 20.0)
        self.assertIsNone(bp.total([{"unit_price": None, "qty": 1}]))


if __name__ == "__main__":
    unittest.main()
