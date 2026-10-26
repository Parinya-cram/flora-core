"""ICU bundle compliance (app/icu_bundles.py) and the KPI projection helpers (app/icu_kpi.py). Pure: no database.

    PYTHONPATH=. python3 -m pytest -q tests/test_icu_bundles.py
"""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app import icu_bundles as ib
from app import icu_kpi as kpi

BKK = ZoneInfo("Asia/Bangkok")
TZ = "Asia/Bangkok"
VAP_ALL = {"ventilated": True, "hob": True, "oral_care": True, "cuff": True, "subglottic": True, "sat_sbt": True}
BRAIN_ALL = {k: True for k in ("hob", "spo2_ok", "paco2_ok", "cpp_ok", "na_ok", "glucose_ok", "normothermia",
                                "sedation_ok", "seizure_ppx", "dvt_ok")}
ROUND_ALL = {"feeding": "enteral", "analgesia_ok": True, "sat_done": "yes", "dvt": "lmwh", "hob_30": True, "ulcer_ppx": True,
             "glucose_ok": True, "sbt_done": "yes", "bowel_ok": True, "lines_reviewed": True, "abx_reviewed": True,
             "cpot": 2, "rass": "0", "rass_target": "-1", "cam_icu": "negative", "mobility": "2", "family_updated": True}


def at(day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(2026, 10, day, hour, minute, tzinfo=BKK).timestamp() * 1000)


def workflow(*forms):
    return {"day_start": "07:00", "forms": [{"form_id": f, "version": 1, "schedule": s} for f, s in forms]}


PER_SHIFT = {"kind": "per_shift", "days": None}
DAILY = {"kind": "daily", "at": "07:00", "days": None}


class EvaluateTest(unittest.TestCase):
    def test_vap_applies_only_when_ventilated(self):
        vap = ib.BY_ID["vap"]
        self.assertEqual(ib.evaluate(vap, {"ventilated": False, "hob": True}),
                         {"applicable": False, "compliant": False, "missing": []})
        self.assertEqual(ib.evaluate(vap, VAP_ALL), {"applicable": True, "compliant": True, "missing": []})
        result = ib.evaluate(vap, {**VAP_ALL, "cuff": False, "subglottic": None})
        self.assertEqual(result, {"applicable": True, "compliant": False, "missing": ["cuff", "subglottic"]})

    def test_brain_always_applies(self):
        brain = ib.BY_ID["brain"]
        self.assertEqual(ib.evaluate(brain, {})["applicable"], True)
        self.assertEqual(len(ib.evaluate(brain, {})["missing"]), 10)
        self.assertTrue(ib.evaluate(brain, {**BRAIN_ALL, "icp_tier": ["tier0"]})["compliant"])

    def test_yes_na_and_select_semantics(self):
        fast = ib.BY_ID["fast_hugs"]
        self.assertTrue(ib.evaluate(fast, ROUND_ALL)["compliant"])
        # Not ventilated: SAT / SBT n/a, still compliant.
        self.assertTrue(ib.evaluate(fast, {**ROUND_ALL, "sat_done": "na", "sbt_done": "na"})["compliant"])
        self.assertEqual(ib.evaluate(fast, {**ROUND_ALL, "sbt_done": "no"})["missing"], ["sbt_done"])
        # "Contraindicated" is a decision made: thromboprophylaxis item done.
        self.assertTrue(ib.evaluate(fast, {**ROUND_ALL, "dvt": "none"})["compliant"])
        abcdef = ib.BY_ID["abcdef"]
        self.assertTrue(ib.evaluate(abcdef, ROUND_ALL)["compliant"])
        self.assertEqual(ib.evaluate(abcdef, {**ROUND_ALL, "cam_icu": None, "rass_target": ""})["missing"],
                         ["c_sedation", "d_delirium"])
        self.assertTrue(ib.evaluate(abcdef, {**ROUND_ALL, "cam_icu": "unable"})["compliant"])

    def test_checkbox_strings(self):
        self.assertEqual(ib.field_state("check", "true"), "done")
        self.assertEqual(ib.field_state("check", False), "missing")
        self.assertEqual(ib.field_state("values", "b", ["a", "b"]), "done")


class CaseRowsTest(unittest.TestCase):
    def test_vap_slots_missed_skipped_pending(self):
        # Case starts 20 Oct 08:00; now 21 Oct 16:00. Shift slots: 20 E, 20 N, 21 D, 21 E (pending: in its shift).
        start, now = at(20, 8), at(21, 16)
        entries = [
            {"id": "e1", "form_id": "critical_icu_vap_check", "slot_ts": at(20, 15), "status": "completed", "data": VAP_ALL},
            {"id": "e2", "form_id": "critical_icu_vap_check", "slot_ts": at(20, 23), "status": "skipped", "data": {}},
        ]
        rows = ib.case_rows(workflow(("critical_icu_vap_check", PER_SHIFT)), entries, start, None, now, TZ)
        self.assertEqual([(r["slot_ts"], r["status"]) for r in rows],
                         [(at(20, 15), "done"), (at(20, 23), "missed"), (at(21, 7), "missed"), (at(21, 15), "pending")])
        self.assertEqual([r["entry_id"] for r in rows][:3], ["e1", "e2", f"slot-critical_icu_vap_check-{at(21, 7)}"])
        self.assertEqual([r["shift"] for r in rows], ["E", "N", "D", "E"])
        self.assertEqual([r["day"] for r in rows], [1, 1, 2, 2])
        # Neighbour rule: the nearest filled shift was ventilated, so the missed ones count.
        self.assertEqual([r["applicable"] for r in rows], [True, True, True, False])
        self.assertEqual(ib.tally(rows), {"applicable": 3, "compliant": 1, "pct": 33.3, "missed": 2})
        self.assertEqual(ib.tally(rows, count_missed=False), {"applicable": 1, "compliant": 1, "pct": 100.0, "missed": 0})

    def test_vap_missed_not_counted_when_not_ventilated(self):
        start, now = at(20, 8), at(21, 16)
        entries = [{"id": "e1", "form_id": "critical_icu_vap_check", "slot_ts": at(20, 15), "status": "completed",
                    "data": {"ventilated": False}}]
        rows = ib.case_rows(workflow(("critical_icu_vap_check", PER_SHIFT)), entries, start, None, now, TZ)
        self.assertEqual(ib.tally(rows)["applicable"], 0)
        # No VAP form filled at all: nothing counted.
        self.assertEqual(ib.tally(ib.case_rows(workflow(("critical_icu_vap_check", PER_SHIFT)), [], start, None, now, TZ))["applicable"], 0)

    def test_brain_missed_always_counts_and_overdue_draft_is_evaluated(self):
        start, now = at(20, 8), at(21, 16)
        entries = [{"id": "b1", "form_id": "neuro_icu_brain_bundle", "slot_ts": at(20, 15), "status": "draft",
                    "data": {**BRAIN_ALL, "na_ok": False}}]
        rows = ib.case_rows(workflow(("neuro_icu_brain_bundle", PER_SHIFT)), entries, start, None, now, TZ)
        self.assertEqual(rows[0]["status"], "draft")
        self.assertEqual(rows[0]["missing"], ["na_ok"])
        self.assertEqual(ib.tally(rows), {"applicable": 3, "compliant": 0, "pct": 0.0, "missed": 2})
        self.assertEqual(ib.top_missing(rows)[0]["item"], "na_ok")

    def test_daily_round_two_bundles_and_discharge_window(self):
        start, discharge = at(20, 8), at(22, 10)
        entries = [{"id": "r1", "form_id": "icu_daily_round", "slot_ts": at(21, 7), "status": "completed", "data": ROUND_ALL},
                   {"id": "r2", "form_id": "icu_daily_round", "slot_ts": at(22, 7), "status": "completed",
                    "data": {**ROUND_ALL, "family_updated": False}}]
        rows = ib.case_rows(workflow(("icu_daily_round", DAILY)), entries, start, discharge, at(25, 9), TZ)
        self.assertEqual(sorted({r["bundle_id"] for r in rows}), ["abcdef", "fast_hugs"])
        fast = [r for r in rows if r["bundle_id"] == "fast_hugs"]
        abcdef = [r for r in rows if r["bundle_id"] == "abcdef"]
        self.assertEqual(ib.tally(fast)["pct"], 100.0)
        self.assertEqual(ib.tally(abcdef)["pct"], 50.0)

    def test_unscheduled_and_unknown_forms_ignored(self):
        wf = {"forms": [{"form_id": "icu_daily_round", "version": 2}, {"form_id": "critical_icu_sofa", "schedule": DAILY}]}
        self.assertEqual(ib.case_rows(wf, [], at(20, 8), None, at(22, 9), TZ), [])

    def test_case_compliance_summary(self):
        start, now = at(20, 8), at(21, 16)
        wf = workflow(("critical_icu_vap_check", PER_SHIFT))
        entries = [{"id": "e1", "form_id": "critical_icu_vap_check", "slot_ts": at(20, 15), "status": "completed",
                    "data": {**VAP_ALL, "cuff": False}}]
        rows = ib.case_rows(wf, entries, start, None, now, TZ)
        [vap] = ib.case_compliance(wf, rows, start, now, TZ)
        self.assertEqual(vap["id"], "vap")
        self.assertEqual((vap["applicable"], vap["compliant"], vap["missed"], vap["pending"]), (3, 0, 2, 1))
        self.assertEqual(len(vap["by_day"]), 7)
        self.assertEqual(vap["by_day"][-1]["date"], "2026-10-21")
        self.assertEqual(vap["by_day"][-2]["applicable"], 2)
        self.assertEqual([s["shift"] for s in vap["today"]], ["D", "E"])
        # The Leaf card also lists the shifts still to come today; they are never counted.
        rows = ib.case_rows(wf, entries, start, None, now, TZ, include_upcoming=True)
        [vap] = ib.case_compliance(wf, rows, start, now, TZ)
        self.assertEqual([(s["shift"], s["status"]) for s in vap["today"]], [("D", "missed"), ("E", "pending"), ("N", "upcoming")])
        self.assertEqual(vap["applicable"], 3)
        self.assertEqual(vap["top_missing"][0]["item"], "cuff")
        self.assertEqual(len(vap["missed_slots"]), 2)


class KpiHelpersTest(unittest.TestCase):
    def test_device_days_union_clipped_to_stay(self):
        items = [{"device": "cvc", "inserted_on": "2026-10-18", "removed_on": "2026-10-21"},
                 {"device": "picc", "inserted_on": "2026-10-20", "removed_on": None},
                 {"device": "foley", "inserted_on": "2026-10-20", "removed_on": "2026-10-20"},
                 {"device": "art", "inserted_on": "2026-10-20"}]
        start, end = at(20, 8), at(23, 10)
        self.assertEqual(kpi.device_days(items, kpi.CENTRAL_LINES, start, end, TZ), 4)   # 20, 21, 22, 23
        self.assertEqual(kpi.device_days(items, kpi.URINARY, start, end, TZ), 1)
        self.assertIsNone(kpi.device_days([], kpi.URINARY, start, end, TZ))

    def test_case_kpi_from_forms(self):
        forms = {"icu_discharge": {"data": {"destination": "death", "mv_days": 3,
                                            "complications": ["vap", "pressure", "reintubation"]}},
                 "icu_lines_devices": {"data": {"items": [{"device": "ett", "inserted_on": "2026-10-20", "removed_on": "2026-10-22"}]}}}
        row = kpi.case_kpi({"start_time": at(20, 8), "discharge_time": at(23, 8)}, forms, TZ)
        self.assertEqual(row["destination"], "death")
        self.assertTrue(row["died"])
        self.assertEqual(row["los_hours"], 72.0)
        self.assertEqual(row["vent_days"], 3)
        self.assertTrue(row["vap"] and row["pressure_injury"] and row["reintubation_48h"])
        self.assertFalse(row["clabsi"] or row["cauti"])
        vent = kpi.case_kpi({"start_time": at(20, 8)}, {"critical_icu_ventilator": {"data": {
            "intubated_at": at(20, 9), "extubated_at": at(21, 21), "reintubated_48h": True}}}, TZ)
        self.assertEqual(vent["vent_days"], 1.5)
        self.assertTrue(vent["reintubation_48h"])
        self.assertIsNone(vent["discharged_at"])

    def test_kpi_summary(self):
        F, T = at(1, 0), at(31, 0)
        rows = [
            # Discharged in the period: 3 days, ventilated 2 days, VAP, died.
            {"admitted_at": at(10, 0), "discharged_at": at(13, 0), "los_hours": 72, "vent_days": 2, "central_line_days": 3,
             "urinary_catheter_days": 0, "vap": True, "died": True, "reintubation_48h": True, "readmission_48h": False},
            # Admitted before the period: half the stay inside → half its device days.
            {"admitted_at": at(1, 0) - 2 * 86_400_000, "discharged_at": at(3, 0), "los_hours": 96, "vent_days": 4,
             "central_line_days": 0, "urinary_catheter_days": 4, "readmission_48h": False},
            # Still in ICU at the end of the period; a readmission.
            {"admitted_at": at(29, 0), "discharged_at": None, "vent_days": 0, "readmission_48h": True},
        ]
        result = kpi.kpi_summary(rows, F, T, at(31, 0), beds=2)
        self.assertEqual((result["admissions"], result["discharges"], result["cases"]), (2, 2, 3))
        self.assertEqual(result["patient_days"], 3 + 2 + 2)
        self.assertEqual(result["alos_days"], 3.5)
        self.assertEqual(result["median_los_days"], 3.5)
        self.assertEqual(result["mortality_pct"], 50.0)
        self.assertEqual(result["vent_days"], 4.0)                    # 2 + 4 × ½
        self.assertEqual(result["vent_utilization"], round(4 / 7, 2))
        self.assertEqual(result["vap_rate"], round(1000 / 6, 2))      # 1 VAP / 6 vent days of discharged cases
        self.assertEqual(result["cauti_rate"], 0.0)                 # no CAUTI over 4 catheter days
        self.assertEqual(result["readmission_48h_pct"], 50.0)
        self.assertEqual(result["reintubation_48h_pct"], 50.0)
        self.assertEqual(result["bed_occupancy_pct"], round(100 * 7 / (2 * 30), 1))

    def test_compliance_summary(self):
        def row(case, bundle, ts, shift, compliant, missed=False, missing=()):
            return {"global_case_id": case, "bundle_id": bundle, "slot_ts": ts, "shift_code": shift, "applicable": True,
                    "compliant": compliant, "missed": missed, "missing": list(missing), "hn": case}
        rows = [row("a", "vap", at(19, 7), "D", True), row("a", "vap", at(19, 15), "E", False, missing=["cuff"]),
                row("b", "vap", at(20, 7), "D", False, missed=True), row("b", "brain", at(20, 7), "D", True)]
        result = kpi.compliance_summary(rows, TZ)
        self.assertEqual(result["overall"]["pct"], 50.0)
        self.assertEqual(result["weeks"], ["2026-10-19"])
        vap = result["bundles"][0]
        self.assertEqual((vap["id"], vap["applicable"], vap["compliant"], vap["missed"], vap["cases"]), ("vap", 3, 1, 1, 2))
        self.assertEqual([s["shift"] for s in vap["by_shift"]], ["D", "E"])
        self.assertEqual(result["top_missing"][0]["item"], "cuff")
        self.assertEqual(result["lowest_cases"][0]["global_case_id"], "a")
        self.assertEqual(kpi.compliance_summary(rows, TZ, count_missed=False)["bundles"][0]["applicable"], 2)

    def test_export_entries(self):
        export = {"tables": {"case_form_entry": [{"id": "x", "form_id": "icu_daily_round", "slot_ts": 1, "status": "completed",
                                                  "data": {"a": 1}}],
                             "case_form_record": [{"form_id": "icu_discharge", "data": {"destination": "ward"}, "status": "completed"}]}}
        self.assertEqual(kpi.export_entries(export)[0]["id"], "x")
        self.assertEqual(kpi.export_forms(export)["icu_discharge"]["data"]["destination"], "ward")


if __name__ == "__main__":
    unittest.main()
