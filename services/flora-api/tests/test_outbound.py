"""Outbound interface message building and scheduling (app/outbound). Pure: no database or network.

    PYTHONPATH=. python3 tests/test_outbound.py   (or python -m unittest tests.test_outbound in the image)
"""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from app.outbound import messages, transport, worker

BKK = ZoneInfo("Asia/Bangkok")


def at(hour: int, minute: int = 0, day: int = 26) -> int:
    return int(datetime(2026, 10, day, hour, minute, tzinfo=BKK).timestamp() * 1000)


SNAPSHOT = {
    "case": {"hn": "6512345", "status": "ACTIVE", "case_code": "6512345_20261026_01", "bed_label": "OR 1",
             "start_time": at(9)},
    "patient": {"row": {"hn": "6512345", "an": "A6900123", "id_card": "1100700123456", "title_th": "นาง",
                        "first_name": "สุภาพร", "last_name": "สมบูรณ์", "sex": "F", "dob": "15/03/2525"}},
    "procedures": {"rows": [{"procedure_text": "Laparoscopic cholecystectomy"}]},
    "vitals": {"rows": [
        {"ts_minute": at(10, 0), "payload": {"hr": 80, "spo2": 99, "nibp_sys": 120}},
        {"ts_minute": at(10, 1), "payload": {"hr": 95, "spo2": 97}},
        {"ts_minute": at(10, 2), "payload": {"pr": 70, "spo2": "98"}},
        {"ts_minute": at(10, 5), "payload": {"hr": 200}},  # next period
    ]},
}
ROW = {"global_case_id": "11111111-2222-3333-4444-555555555555", "unit_name": "OR Suite"}
DESTINATION = {"sending_application": "FLORA", "sending_facility": "KCMH", "receiving_application": "HIS"}


class CandleTest(unittest.TestCase):
    def test_first_max_min_last_per_period(self):
        items = {item["param"]: item for item in messages.candles(SNAPSHOT, at(10, 0), at(10, 5))}
        self.assertEqual((items["hr"]["first"], items["hr"]["max"], items["hr"]["min"], items["hr"]["last"]), (80, 95, 70, 70))
        self.assertEqual((items["spo2"]["min"], items["spo2"]["count"]), (97, 3))
        self.assertEqual(items["nibp_sys"]["first"], items["nibp_sys"]["last"])
        self.assertNotIn("rr", items)

    def test_empty_period(self):
        self.assertEqual(messages.candles(SNAPSHOT, at(11), at(11, 5)), [])


class Hl7Test(unittest.TestCase):
    def test_vitals_oru(self):
        ctx = messages.context(SNAPSHOT, ROW, "full")
        items = messages.candles(SNAPSHOT, at(10, 0), at(10, 5))
        text = messages.hl7_vitals(DESTINATION, ctx, items, at(10, 0), at(10, 5), "FL1", at(10, 7))
        segments = text.rstrip("\r").split("\r")
        self.assertTrue(segments[0].startswith("MSH|^~\\&|FLORA|KCMH|HIS||"))
        self.assertIn("|ORU^R01^ORU_R01|FL1|P|2.5.1|", segments[0])
        pid = segments[1].split("|")
        self.assertEqual(pid[3], "6512345^^^KCMH^MR~1100700123456^^^THA^NI")
        self.assertEqual(pid[5], "สมบูรณ์^สุภาพร^^^นาง")
        self.assertEqual(pid[7], "19820315")  # Buddhist year converted
        obx = [s.split("|") for s in segments if s.startswith("OBX")]
        self.assertEqual(len(obx), 3 * 4)
        self.assertEqual((obx[1][3].split("^")[0], obx[1][4], obx[1][5]), ("8867-4", "1.2", "95"))

    def test_masked_identity(self):
        ctx = messages.context(SNAPSHOT, ROW, "masked")
        text = messages.hl7_document(DESTINATION, ctx, "discharge", b"%PDF-1.4", "FL2", at(12))
        self.assertNotIn("6512345", text)
        self.assertNotIn("สุภาพร", text)
        self.assertNotIn("1100700123456", text)
        self.assertIn("651--------", text)
        self.assertIn("|ED|PDF^Anaesthesia record^L|1|^AP^PDF^Base64^JVBERi0xLjQ=|", text)

    def test_escaping(self):
        self.assertEqual(messages.esc("a|b^c&d~e\\f\ng"), "a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f\\.br\\g")

    def test_ack(self):
        self.assertEqual(transport.ack_status("MSH|^~\\&|X\rMSA|AA|FL1\r"), ("AA", ""))
        self.assertEqual(transport.ack_status("MSH|^~\\&|X\rMSA|AR|FL1|bad PID\r"), ("AR", "bad PID"))


class FhirTest(unittest.TestCase):
    def test_vitals_bundle(self):
        ctx = messages.context(SNAPSHOT, ROW, "full")
        bundle = messages.fhir_vitals(DESTINATION, ctx, messages.candles(SNAPSHOT, at(10), at(10, 5)), at(10), at(10, 5))
        types = [entry["resource"]["resourceType"] for entry in bundle["entry"]]
        self.assertEqual(types[:2], ["Patient", "Encounter"])
        hr = bundle["entry"][2]["resource"]
        self.assertEqual(hr["code"]["coding"][0]["code"], "8867-4")
        self.assertEqual([c["valueQuantity"]["value"] for c in hr["component"]], [80, 95, 70, 70])
        self.assertEqual(hr["subject"]["reference"], bundle["entry"][0]["fullUrl"])

    def test_document_bundle(self):
        ctx = messages.context(SNAPSHOT, ROW, "full")
        report = messages.fhir_document(DESTINATION, ctx, "form", b"%PDF", at(12))["entry"][2]["resource"]
        self.assertEqual(report["presentedForm"][0]["contentType"], "application/pdf")


class ScheduleTest(unittest.TestCase):
    def test_delay(self):
        self.assertEqual(worker.due_time({"timing": "delay", "delay_seconds": 90}, at(10)), at(10) + 90_000)

    def test_daily_midnight_is_next_day(self):
        self.assertEqual(worker.due_time({"timing": "daily", "daily_at": "00:00"}, at(10)), at(0, day=27))
        self.assertEqual(worker.due_time({"timing": "daily", "daily_at": "23:30"}, at(10)), at(23, 30))

    def test_wards(self):
        self.assertTrue(worker.serves({"unit_keys": ["*"]}, None))
        self.assertTrue(worker.serves({"unit_keys": ["6", "3"]}, "3"))
        self.assertFalse(worker.serves({"unit_keys": ["6"]}, "3"))

    def test_log_copy_is_masked_for_full_identity(self):
        destination = {**DESTINATION, "identity": "full", "feeds": {"form": {"pdf": False}}}
        case = {**ROW, "snapshot": SNAPSHOT}
        _, message, _, log_copy = worker.build(destination, "form", case, "FL9")
        self.assertIn("สุภาพร", message)
        self.assertNotIn("สุภาพร", log_copy)
        self.assertNotIn("6512345", worker.loggable(log_copy))
        _, message, _, log_copy = worker.build({**destination, "format": "fhir"}, "vitals", case, "FL10", (at(10), at(10, 5)))
        self.assertNotIn("1100700123456", worker.loggable(log_copy))

    def test_tls_settings_rejected_early(self):
        with self.assertRaises(transport.SendError):
            transport.tls_context({"tls": True, "ca_cert": "not a pem"})

    def test_loggable_shortens_pdf(self):
        text = worker.loggable("MSH|x\rOBX|1|ED|PDF^r^L|1|^AP^PDF^Base64^AAAAAAAA||||||F\r")
        self.assertIn("^AP^PDF^Base64^<6 bytes>||||||F", text)


if __name__ == "__main__":
    unittest.main()
