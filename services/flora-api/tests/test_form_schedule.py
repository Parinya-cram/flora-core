"""Scheduled workflow form slots (app/form_schedule.py, docs/ICU-ROUNDS.md). Pure: no database.

    PYTHONPATH=. python3 tests/test_form_schedule.py   (or python -m unittest tests.test_form_schedule in the image)
"""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app import form_schedule as fs

BKK = ZoneInfo("Asia/Bangkok")
TZ = "Asia/Bangkok"


def at(day: int, hour: int, minute: int = 0, month: int = 10) -> int:
    return int(datetime(2026, month, day, hour, minute, tzinfo=BKK).timestamp() * 1000)


class DailyTest(unittest.TestCase):
    schedule = {"kind": "daily", "at": "07:00", "days": None}

    def test_daily_0700_bangkok_with_statuses(self):
        slots = fs.slots(self.schedule, at(20, 8, 30), None, at(23, 7, 30), TZ)
        self.assertEqual([s["slot_ts"] for s in slots], [at(21, 7), at(22, 7), at(23, 7), at(24, 7)])
        self.assertEqual([s["status"] for s in slots], ["overdue", "overdue", "due", "upcoming"])
        self.assertEqual([s["day"] for s in slots], [2, 3, 4, 5])
        self.assertEqual(slots[0]["label"], "Day 2 · 07:00")
        self.assertIsNone(slots[0]["shift"])
        self.assertEqual(fs.summary(slots), {"due": 1, "overdue": 2, "done": 0})
        self.assertEqual(fs.next_slot_ts(slots), at(21, 7))

    def test_entries_set_status(self):
        entries = [{"id": "a", "slot_ts": at(21, 7), "status": "completed", "completed_by": "nurse", "completed_at": 5,
                    "updated_at": 6},
                   {"id": "b", "slot_ts": at(22, 7), "status": "skipped"},
                   {"id": "c", "slot_ts": at(23, 7), "status": "draft"},
                   {"id": "u", "slot_ts": None, "status": "completed"}]
        slots = fs.slots(self.schedule, at(20, 8, 30), None, at(23, 7, 30), TZ, entries=entries)
        self.assertEqual([s["status"] for s in slots], ["done", "skipped", "draft", "upcoming"])
        self.assertEqual([s["entry_id"] for s in slots], ["a", "b", "c", None])
        self.assertEqual(slots[3]["completedBy"], None)
        self.assertEqual((slots[0]["completedBy"], slots[0]["completedAt"], slots[0]["updatedAt"]), ("nurse", 5, 6))
        self.assertEqual(fs.summary(slots), {"due": 0, "overdue": 0, "done": 1})
        self.assertEqual(fs.next_slot_ts(slots), at(24, 7))

    def test_first_slot_at_or_after_start_minute(self):
        slots = fs.slots(self.schedule, at(20, 7), None, at(20, 8), TZ)
        self.assertEqual(slots[0]["slot_ts"], at(20, 7))
        self.assertEqual(slots[0]["day"], 1)
        late = fs.slots(self.schedule, at(20, 7) + 30_000, None, at(20, 8), TZ)  # 07:00:30
        self.assertEqual(late[0]["slot_ts"], at(21, 7))

    def test_start_before_day_start_belongs_to_previous_day(self):
        # Started 02:00 on the 21st: day 1 began at 07:00 on the 20th, so 07:00 on the 21st is day 2.
        slots = fs.slots(self.schedule, at(21, 2), None, at(21, 8), TZ)
        self.assertEqual((slots[0]["slot_ts"], slots[0]["day"]), (at(21, 7), 2))

    def test_days_limit(self):
        slots = fs.slots({**self.schedule, "days": 7}, at(20, 8, 30), None, at(10, 12, month=11), TZ)
        self.assertEqual(len(slots), 7)
        self.assertEqual(slots[-1]["slot_ts"], at(27, 7))

    def test_discharge_stops_slots(self):
        slots = fs.slots(self.schedule, at(20, 8, 30), at(22, 10), at(25, 12), TZ)
        self.assertEqual([s["slot_ts"] for s in slots], [at(21, 7), at(22, 7)])

    def test_upcoming_only_24h_ahead(self):
        slots = fs.slots(self.schedule, at(20, 8, 30), None, at(20, 9), TZ)
        self.assertEqual([s["slot_ts"] for s in slots], [at(21, 7)])
        self.assertEqual(slots[0]["status"], "upcoming")

    def test_grace(self):
        schedule = {**self.schedule, "grace_min": 30}
        self.assertEqual(fs.slots(schedule, at(20, 6), None, at(20, 7, 29), TZ)[0]["status"], "due")
        self.assertEqual(fs.slots(schedule, at(20, 6), None, at(20, 7, 30), TZ)[0]["status"], "overdue")
        # Default grace is 120 minutes.
        self.assertEqual(fs.slots(self.schedule, at(20, 6), None, at(20, 8, 59), TZ)[0]["status"], "due")
        self.assertEqual(fs.slots(self.schedule, at(20, 6), None, at(20, 9), TZ)[0]["status"], "overdue")

    def test_timezone(self):
        # 07:00 UTC is 14:00 in Bangkok.
        slots = fs.slots(self.schedule, at(20, 8, 30), None, at(20, 20), "UTC")
        self.assertEqual(slots[0]["slot_ts"], at(20, 14))
        self.assertEqual(fs.zone("Nowhere/Nope"), BKK)


class EveryTest(unittest.TestCase):
    def test_every_8h_anchored_at_day_start(self):
        slots = fs.slots({"kind": "every", "every_hours": 8, "days": None}, at(20, 8), None, at(20, 8), TZ)
        self.assertEqual([s["slot_ts"] for s in slots], [at(20, 15), at(20, 23), at(21, 7)])
        self.assertEqual([s["label"] for s in slots], ["Day 1 · 15:00", "Day 1 · 23:00", "Day 2 · 07:00"])

    def test_every_6h_with_other_day_start(self):
        slots = fs.slots({"kind": "every", "every_hours": 6}, at(20, 9), None, at(20, 10), TZ, day_start="08:00")
        self.assertEqual([s["slot_ts"] for s in slots][:3], [at(20, 14), at(20, 20), at(21, 2)])


class PerShiftTest(unittest.TestCase):
    schedule = {"kind": "per_shift", "days": None}

    def test_across_midnight(self):
        slots = fs.slots(self.schedule, at(20, 22), None, at(21, 1), TZ)
        self.assertEqual([s["slot_ts"] for s in slots[:4]], [at(20, 23), at(21, 7), at(21, 15), at(21, 23)])
        self.assertEqual([s["shift"] for s in slots[:4]], ["N", "D", "E", "N"])
        self.assertEqual([s["label"] for s in slots[:2]], ["Day 1 · N", "Day 2 · D"])
        # Default grace is the shift length: the night shift is due until 07:00.
        self.assertEqual(slots[0]["status"], "due")
        later = fs.slots(self.schedule, at(20, 22), None, at(21, 7, 30), TZ)
        self.assertEqual([s["status"] for s in later[:2]], ["overdue", "due"])
        self.assertEqual(fs.summary(later), {"due": 1, "overdue": 1, "done": 0})

    def test_custom_shifts(self):
        shifts = [{"code": "AM", "label": "Day", "start": "08:00"}, {"code": "PM", "label": "Night", "start": "20:00"}]
        slots = fs.slots(self.schedule, at(20, 9), None, at(20, 10), TZ, day_start="08:00", shifts=shifts)
        self.assertEqual([(s["slot_ts"], s["shift"]) for s in slots], [(at(20, 20), "PM"), (at(21, 8), "AM")])
        # PM lasts 12 h (20:00 → 08:00).
        self.assertEqual(fs.slots(self.schedule, at(20, 9), None, at(21, 7, 59), TZ, "08:00", shifts)[0]["status"], "due")


class ValidationTest(unittest.TestCase):
    def paths(self, issues):
        return [issue["path"] for issue in issues]

    def test_schedule(self):
        self.assertEqual(fs.schedule_issues(None, "$.s"), [])
        self.assertEqual(fs.schedule_issues({"kind": "daily", "at": "07:00", "days": None, "grace_min": 120}, "$.s"), [])
        self.assertEqual(fs.schedule_issues({"kind": "every", "every_hours": 8, "days": 7}, "$.s"), [])
        self.assertEqual(fs.schedule_issues({"kind": "per_shift"}, "$.s"), [])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "weekly"}, "$.s")), ["$.s.kind"])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "daily", "at": "7:00"}, "$.s")), ["$.s.at"])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "daily", "at": "24:00"}, "$.s")), ["$.s.at"])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "every", "every_hours": 0}, "$.s")), ["$.s.every_hours"])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "every", "every_hours": 25}, "$.s")), ["$.s.every_hours"])
        self.assertEqual(self.paths(fs.schedule_issues({"kind": "per_shift", "days": 0, "grace_min": True}, "$.s")),
                         ["$.s.days", "$.s.grace_min"])
        self.assertEqual(self.paths(fs.schedule_issues("daily", "$.s")), ["$.s"])

    def test_day_settings(self):
        self.assertEqual(fs.day_settings_issues("07:00", fs.DEFAULT_SHIFTS), [])
        self.assertEqual(fs.day_settings_issues(None, None), [])
        self.assertEqual(self.paths(fs.day_settings_issues("7am", None)), ["$.day_start"])
        duplicate = [{"code": "D", "start": "07:00"}, {"code": "D", "start": "19:00"}]
        self.assertEqual(self.paths(fs.day_settings_issues(None, duplicate)), ["$.shifts[1].code"])
        unordered = [{"code": "N", "start": "23:00"}, {"code": "D", "start": "07:00"}]
        self.assertEqual(self.paths(fs.day_settings_issues(None, unordered)), ["$.shifts[1].start"])
        self.assertEqual(self.paths(fs.day_settings_issues(None, [{"code": "D", "start": "7:00"}])), ["$.shifts[0].start"])
        self.assertEqual(self.paths(fs.day_settings_issues(None, [])), ["$.shifts"])

    def test_workflow_settings_defaults(self):
        self.assertEqual(fs.workflow_day_start({}), "07:00")
        self.assertEqual(fs.workflow_day_start({"day_start": "08:00"}), "08:00")
        self.assertEqual([s["code"] for s in fs.workflow_shifts({})], ["D", "E", "N"])
        self.assertEqual([s["code"] for s in fs.workflow_shifts({"shifts": [{"code": "A", "start": "06:00"}]})], ["A"])

    def test_normalize_schedule(self):
        self.assertIsNone(fs.normalize_schedule(None))
        self.assertEqual(fs.normalize_schedule({"kind": "daily", "at": "07:00", "every_hours": 8}),
                         {"kind": "daily", "at": "07:00", "days": None})


class ShiftWindowTest(unittest.TestCase):
    def test_default_shifts(self):
        self.assertEqual(fs.shift_window(at(21, 10), None, TZ),
                         {"code": "D", "label": "Day", "start": at(21, 7), "end": at(21, 15)})
        self.assertEqual(fs.shift_window(at(21, 15), None, TZ)["code"], "E")  # start is inclusive
        self.assertEqual(fs.shift_window(at(21, 14, 59), None, TZ)["code"], "D")

    def test_night_across_midnight(self):
        before = fs.shift_window(at(21, 23, 30), None, TZ)
        after = fs.shift_window(at(22, 2), None, TZ)
        self.assertEqual(before, after)
        self.assertEqual((after["code"], after["start"], after["end"]), ("N", at(21, 23), at(22, 7)))

    def test_previous_and_offset(self):
        self.assertEqual(fs.previous_shift_window(at(22, 8), None, TZ)["start"], at(21, 23))
        self.assertEqual(fs.previous_shift_window(at(22, 2), None, TZ)["start"], at(21, 15))
        self.assertEqual(fs.shift_window(at(22, 8), None, TZ, -3)["start"], at(21, 7))
        self.assertEqual(fs.shift_window(at(21, 23, 30), None, TZ, 1)["start"], at(22, 7))

    def test_custom_shifts_and_timezone(self):
        shifts = [{"code": "AM", "label": "Day", "start": "08:00"}, {"code": "PM", "label": "Night", "start": "20:00"}]
        window = fs.shift_window(at(22, 7), shifts, TZ)
        self.assertEqual((window["code"], window["start"], window["end"]), ("PM", at(21, 20), at(22, 8)))
        # 07:00 UTC is 14:00 in Bangkok; the D shift in UTC runs 14:00-22:00 Bangkok time.
        utc = fs.shift_window(at(21, 15), None, "UTC")
        self.assertEqual((utc["code"], utc["start"], utc["end"]), ("D", at(21, 14), at(21, 22)))


if __name__ == "__main__":
    unittest.main()
