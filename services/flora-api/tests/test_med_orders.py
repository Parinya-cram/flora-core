"""Medication orders + MAR (app/med_orders.py) and staff PIN approvals (app/staff_pin.py). Pure: no database.

    PYTHONPATH=. python3 -m pytest -q tests/test_med_orders.py
"""
import contextlib
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app import med_orders as mo
from app import staff_pin as sp

BKK = ZoneInfo("Asia/Bangkok")
TZ = "Asia/Bangkok"
HOUR = 3_600_000


def at(day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(2026, 10, day, hour, minute, tzinfo=BKK).timestamp() * 1000)


def order(**values):
    base = {"order_type": "continue", "prn": False, "status": "active", "start_at": at(20, 7), "schedule": None,
            "end_at": None, "duration_days": None, "discontinued_at": None, "activated_at": None, "holds": []}
    return {**base, **values}


class DueTimesTest(unittest.TestCase):
    def test_q8h_with_anchor(self):
        o = order(start_at=at(20, 10), schedule={"kind": "every", "every_hours": 8, "anchor": "06:00"})
        self.assertEqual(mo.due_times(o, at(20, 0), at(21, 23, 59), TZ),
                         [at(20, 14), at(20, 22), at(21, 6), at(21, 14), at(21, 22)])

    def test_q8h_default_anchor_is_start_time(self):
        o = order(start_at=at(20, 9, 30), schedule={"kind": "every", "every_hours": 8})
        self.assertEqual(mo.due_times(o, at(20, 0), at(21, 2), TZ), [at(20, 9, 30), at(20, 17, 30), at(21, 1, 30)])

    def test_times_across_midnight_bangkok(self):
        o = order(start_at=at(20, 9), schedule={"kind": "times", "times": ["20:00", "08:00", "00:00"]})
        # Bangkok midnight is 17:00 UTC the day before.
        self.assertEqual(at(21, 0), int(datetime(2026, 10, 20, 17, 0, tzinfo=ZoneInfo("UTC")).timestamp() * 1000))
        self.assertEqual(mo.due_times(o, at(20, 0), at(21, 23, 59), TZ),
                         [at(20, 20), at(21, 0), at(21, 8), at(21, 20)])

    def test_window_is_inclusive(self):
        o = order(schedule={"kind": "times", "times": ["08:00"]})
        self.assertEqual(mo.due_times(o, at(21, 8), at(21, 8), TZ), [at(21, 8)])
        self.assertEqual(mo.due_times(o, at(21, 8, 1), at(21, 9), TZ), [])

    def test_once(self):
        o = order(order_type="once", start_at=at(20, 13, 15))
        self.assertEqual(mo.due_times(o, at(20, 0), at(20, 23), TZ), [at(20, 13, 15)])
        self.assertEqual(mo.due_times(o, at(21, 0), at(21, 23), TZ), [])

    def test_prn_and_infusion_have_no_slots(self):
        prn = order(prn=True, schedule={"kind": "every", "every_hours": 4})
        drip = order(schedule={"kind": "infusion", "rate": 5, "rate_unit": "ml/h"})
        self.assertEqual(mo.due_times(prn, at(20, 0), at(22, 0), TZ), [])
        self.assertEqual(mo.due_times(drip, at(20, 0), at(22, 0), TZ), [])

    def test_discontinued_order_stops(self):
        o = order(status="discontinued", discontinued_at=at(21, 14),
                  schedule={"kind": "every", "every_hours": 8, "anchor": "06:00"})
        # The 14:00 dose at the moment of discontinuation is not due any more.
        self.assertEqual(mo.due_times(o, at(21, 0), at(21, 23), TZ), [at(21, 6)])

    def test_end_at_and_duration(self):
        sched = {"kind": "times", "times": ["08:00", "20:00"]}
        self.assertEqual(mo.due_times(order(schedule=sched, end_at=at(21, 20)), at(20, 0), at(23, 0), TZ),
                         [at(20, 8), at(20, 20), at(21, 8)])
        self.assertEqual(mo.due_times(order(schedule=sched, duration_days=1), at(20, 0), at(23, 0), TZ),
                         [at(20, 8), at(20, 20)])

    def test_pending_approval_has_no_slots_and_activation_moves_the_start(self):
        sched = {"kind": "every", "every_hours": 6, "anchor": "00:00"}
        self.assertEqual(mo.due_times(order(status="pending_approval", schedule=sched), at(20, 0), at(21, 0), TZ), [])
        self.assertEqual(mo.due_times(order(schedule=sched, activated_at=at(20, 13)), at(20, 0), at(20, 23, 59), TZ),
                         [at(20, 18)])


class MarStatusTest(unittest.TestCase):
    sched = {"kind": "times", "times": ["08:00", "12:00", "16:00", "20:00"]}

    def test_slot_statuses(self):
        o = order(schedule=self.sched)
        admins = [{"id": "a1", "due_at": at(20, 8), "status": "given"}, {"id": "a2", "due_at": at(20, 16), "status": "refused"}]
        slots = mo.mar_slots(o, admins, at(20, 0), at(20, 23, 59), at(20, 19, 30), TZ)
        self.assertEqual([s["status"] for s in slots], ["given", "overdue", "refused", "due"])
        self.assertEqual(slots[0]["admin_id"], "a1")
        later = mo.mar_slots(o, [], at(20, 0), at(20, 23, 59), at(20, 18, 59), TZ)
        self.assertEqual(later[-1]["status"], "upcoming")

    def test_hold_period(self):
        o = order(schedule=self.sched, status="held", holds=[{"from": at(20, 11), "to": None}])
        slots = mo.mar_slots(o, [], at(20, 0), at(20, 23, 59), at(20, 19), TZ)
        self.assertEqual([s["status"] for s in slots], ["overdue", "held", "held", "held"])

    def test_recorded_dose_off_schedule_stays_visible(self):
        o = order(schedule={"kind": "times", "times": ["09:00"]})
        slots = mo.mar_slots(o, [{"id": "x", "due_at": at(20, 8), "status": "given"}], at(20, 0), at(20, 23), at(20, 12), TZ)
        self.assertEqual([(s["due_at"], s["status"]) for s in slots], [(at(20, 8), "given"), (at(20, 9), "overdue")])


class ValidationTest(unittest.TestCase):
    def test_schedule_rules(self):
        self.assertTrue(mo.schedule_issues("continue", False, None))
        self.assertEqual(mo.schedule_issues("continue", True, None), [])
        self.assertEqual(mo.schedule_issues("once", False, None), [])
        self.assertTrue(mo.schedule_issues("once", False, {"kind": "every", "every_hours": 8}))
        self.assertTrue(mo.schedule_issues("continue", False, {"kind": "every", "every_hours": 0}))
        self.assertTrue(mo.schedule_issues("continue", False, {"kind": "times", "times": ["8:00"]}))
        self.assertEqual(mo.schedule_issues("continue", False, {"kind": "infusion", "rate": 3}), [])

    def test_approval_union_only_gets_stricter(self):
        self.assertEqual(mo.approval_union("none", None), "none")
        self.assertEqual(mo.approval_union("order", "admin"), "both")
        self.assertEqual(mo.approval_union("both", "none"), "both")
        self.assertEqual(mo.approval_union("admin", "bogus"), "admin")


class EligibilityTest(unittest.TestCase):
    doctors = [{"staff_code": "D10", "seniority": 10}, {"staff_code": "D30", "seniority": 30}]

    def test_owner_is_most_senior_doctor(self):
        self.assertEqual(mo.owner_seniority(self.doctors), 30)
        self.assertEqual([d["staff_code"] for d in mo.case_owners(self.doctors)], ["D30"])

    def test_owner_may_approve(self):
        # Matched by code, even when the directory lists them with a junior role.
        self.assertTrue(mo.can_approve({"staff_code": "d30", "staff_type": "doctor", "seniority": 10}, self.doctors))

    def test_higher_or_equal_doctor_may_approve(self):
        self.assertTrue(mo.can_approve({"staff_code": "X", "staff_type": "doctor", "seniority": 30}, self.doctors))
        self.assertTrue(mo.can_approve({"staff_code": "X", "staff_type": "doctor", "seniority": 40}, self.doctors))

    def test_lower_doctor_may_not(self):
        self.assertFalse(mo.can_approve({"staff_code": "D10", "staff_type": "doctor", "seniority": 10}, self.doctors))
        self.assertFalse(mo.can_approve({"staff_code": "F", "staff_type": "doctor", "seniority": 20}, self.doctors))

    def test_nurse_may_not(self):
        self.assertFalse(mo.can_approve({"staff_code": "N1", "staff_type": "nurse", "seniority": 99}, self.doctors))

    def test_no_doctor_on_case_needs_attending(self):
        self.assertFalse(mo.can_approve({"staff_code": "F", "staff_type": "doctor", "seniority": 20}, []))
        self.assertTrue(mo.can_approve({"staff_code": "A", "staff_type": "doctor", "seniority": 30}, []))


class FakeDatabase:
    """Just enough of a psycopg connection for staff_pin.attempt."""

    def __init__(self, row):
        self.row = row

    @contextlib.contextmanager
    def transaction(self):
        yield

    def execute(self, sql, params):
        db = self

        class Result:
            def fetchone(self):
                return dict(db.row)
        if sql.startswith("UPDATE staff_directory SET pin_failed=%s"):
            failed, until, _ = params
            self.row["pin_failed"] = failed
            if until is not None:
                self.row["pin_locked_until"] = until
        elif sql.startswith("UPDATE staff_directory SET pin_failed=0"):
            self.row.update(pin_failed=0, pin_locked_until=None)
        return Result()


class PinTest(unittest.TestCase):
    def test_hash_and_verify(self):
        stored = sp.hash_pin("4821")
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertNotIn("4821", stored)
        self.assertTrue(sp.verify_pin("4821", stored))
        self.assertFalse(sp.verify_pin("4822", stored))
        self.assertFalse(sp.verify_pin("4821", None))
        self.assertNotEqual(stored, sp.hash_pin("4821"))  # salted

    def test_pin_format(self):
        for good in ("1234", "123456"):
            self.assertTrue(sp.valid_pin(good))
        for bad in ("123", "1234567", "12a4", None, 1234):
            self.assertFalse(sp.valid_pin(bad))
        with self.assertRaises(ValueError):
            sp.hash_pin("12")

    def test_check_order(self):
        now = 1_000_000
        stored = sp.hash_pin("1111")
        self.assertEqual(sp.check({"pin_hash": None}, "1111", now), "no_pin_set")
        self.assertEqual(sp.check({"pin_hash": stored, "pin_locked_until": now + 1}, "1111", now), "pin_locked")
        self.assertEqual(sp.check({"pin_hash": stored, "pin_locked_until": now - 1}, "1111", now), None)
        self.assertEqual(sp.check({"pin_hash": stored}, "2222", now), "pin_invalid")

    def test_lockout_after_five_failures(self):
        self.assertEqual(sp.after_failure(0, 0), (1, None))
        self.assertEqual(sp.after_failure(4, 100), (0, 100 + sp.LOCK_MS))
        db = FakeDatabase({"id": 1, "pin_hash": sp.hash_pin("1111"), "pin_failed": 0, "pin_locked_until": None})
        seen = []
        results = [sp.attempt(db, 1, "0000", seen.append) for _ in range(5)]
        self.assertEqual(results, ["pin_invalid"] * 4 + ["pin_locked"])
        self.assertEqual(sp.attempt(db, 1, "1111"), "pin_locked")  # even the right PIN while locked
        self.assertEqual(seen, results)
        db.row["pin_locked_until"] = 1  # lock expired
        self.assertIsNone(sp.attempt(db, 1, "1111"))
        self.assertEqual(db.row["pin_failed"], 0)


if __name__ == "__main__":
    unittest.main()
