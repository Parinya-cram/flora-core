import unittest
from unittest.mock import patch

from app.main import observations_for_minute


class LiveAgentTests(unittest.TestCase):
    @patch('app.main.PROFILE', 'stable-anes')
    def test_snapshot_is_deterministic_and_contains_core_vitals(self):
        timestamp = 1_800_000_000_000
        first = observations_for_minute(timestamp)
        second = observations_for_minute(timestamp)
        self.assertEqual(first, second)
        params = {row["ivy_param"] for row in first}
        self.assertTrue({"hr", "spo2", "art_sys", "art_dia", "etco2", "set_vent_mode"}.issubset(params))
        self.assertTrue(all(row["synthetic"] is True for row in first))


if __name__ == "__main__":
    unittest.main()
