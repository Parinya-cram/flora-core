"""The hospital's name and logo (0090, app/hospital_profile.py): set in Canopy, delivered with the ward exchange and
kept on the Leaf, against a disposable PostgreSQL database (scripts/test-leaf-writes.sh)."""
import os
import unittest
from urllib.parse import urlparse

URL = os.environ.get("FLORA_DATABASE_URL", "")
if not urlparse(URL).path.endswith("_test"):
    raise unittest.SkipTest("hospital profile tests need a dedicated database ending in _test")

import psycopg  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from app import hospital_profile  # noqa: E402
from app.routes import fleet_read  # noqa: E402

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


class HospitalProfile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = psycopg.connect(URL, autocommit=True, row_factory=dict_row)

    @classmethod
    def tearDownClass(cls):
        cls.db.execute("DELETE FROM canopy_hospital_profile")
        cls.db.execute("DELETE FROM leaf_hospital_profile")
        cls.db.close()

    def setUp(self):
        self.db.execute("DELETE FROM canopy_hospital_profile")
        self.db.execute("DELETE FROM leaf_hospital_profile")

    def test_none_until_set_so_the_leaf_keeps_its_built_in_header(self):
        self.assertIsNone(hospital_profile.canopy_get(self.db))
        self.assertIsNone(hospital_profile.delivery(self.db), "nothing is sent: the Leaf keeps what it has")
        self.assertEqual(hospital_profile.leaf_get(self.db), {})

    def test_set_in_canopy_delivered_and_kept_on_the_leaf(self):
        saved = hospital_profile.canopy_put(self.db, {"name_th": "  โรงพยาบาลทดสอบ ", "name_en": "Test Hospital", "logo": PNG}, "admin")
        self.assertEqual((saved["name_th"], saved["name_en"], saved["logo"], saved["updated_by"]), ("โรงพยาบาลทดสอบ", "Test Hospital", PNG, "admin"))
        delivered = hospital_profile.delivery(self.db)
        self.assertEqual(delivered["name_en"], "Test Hospital")
        hospital_profile.leaf_put(self.db, delivered)
        kept = hospital_profile.leaf_get(self.db)
        self.assertEqual((kept["name_th"], kept["logo"], kept["updated_at"]), ("โรงพยาบาลทดสอบ", PNG, saved["updated_at"]))
        self.assertTrue(kept["synced_at"])
        # A later change replaces the Leaf's copy (the worker sends it when its digest changes).
        hospital_profile.canopy_put(self.db, {"name_th": "โรงพยาบาลทดสอบ", "name_en": "Test Hospital", "logo": None}, "admin")
        hospital_profile.leaf_put(self.db, hospital_profile.delivery(self.db))
        self.assertIsNone(hospital_profile.leaf_get(self.db)["logo"], "a removed logo is removed on the Leaf too")

    def test_the_logo_must_be_a_small_png_or_jpeg(self):
        for logo in ("https://example.com/logo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64," + "A" * 400_000):
            with self.assertRaises(HTTPException) as caught:
                hospital_profile.canopy_put(self.db, {"name_en": "X", "logo": logo}, "admin")
            self.assertEqual(caught.exception.status_code, 422)
            with self.assertRaises(HTTPException):
                hospital_profile.leaf_put(self.db, {"name_en": "X", "logo": logo})
        self.assertIsNone(hospital_profile.canopy_get(self.db))

    def test_only_config_managers_change_it_in_canopy(self):
        with self.assertRaises(HTTPException) as caught:
            fleet_read.put_hospital_profile({"name_en": "X"}, {"username": "nurse", "_permissions": ["form.review"]}, self.db)
        self.assertEqual(caught.exception.status_code, 403)
        result = fleet_read.put_hospital_profile({"name_en": "X"}, {"username": "admin", "_permissions": ["config.manage"]}, self.db)
        self.assertEqual(result["profile"]["name_en"], "X")
        self.assertEqual(fleet_read.get_hospital_profile({"username": "nurse"}, self.db)["profile"]["name_en"], "X")


if __name__ == "__main__":
    unittest.main()
