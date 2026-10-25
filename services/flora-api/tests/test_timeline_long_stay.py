"""Long-stay chart helpers in routes/cases_read.py: step clamp, windowed axis, bucketed effective timeline.

Pure functions; no database needed (the module is imported, nothing is queried).
"""
import unittest

from app.routes.cases_read import AXIS_STEPS, axis_points, bucket_effective_rows, normalize_axis_step

M = 60_000
H = 60 * M


class StepClampTest(unittest.TestCase):
    def test_listed_steps_pass(self):
        for step in AXIS_STEPS:
            self.assertEqual(normalize_axis_step(step), step)

    def test_legacy_values_up_to_120_kept(self):
        self.assertEqual(normalize_axis_step(7), 7)
        self.assertEqual(normalize_axis_step(None), 1)
        self.assertEqual(normalize_axis_step(0), 1)

    def test_large_values_snap_to_list(self):
        self.assertEqual(normalize_axis_step(200), 240)
        self.assertEqual(normalize_axis_step(1000), 720)
        self.assertEqual(normalize_axis_step(99999), 1440)


class AxisTest(unittest.TestCase):
    start = 1_000 * H + 37 * M  # case start, not on an hour

    def test_default_grid_unchanged(self):
        axis = axis_points(self.start, self.start + 10 * M, 5)
        self.assertEqual(axis, [self.start + i * 5 * M for i in range(3)])

    def test_window_limits_the_grid(self):
        axis = axis_points(self.start, self.start + 3 * 24 * H, 60,
                           window_from=self.start + 24 * H + 1, window_to=self.start + 26 * H)
        self.assertEqual(axis, [self.start + 25 * H, self.start + 26 * H])

    def test_anchor_aligns_coarse_steps_and_covers_the_tail(self):
        anchor = 1_000 * H  # Day 1 start
        axis = axis_points(self.start, self.start + 9 * H, 240, anchor=anchor)
        # columns end on anchor + k*4h; the first covers the case start, the last the end
        self.assertEqual(axis, [anchor + 4 * H, anchor + 8 * H, anchor + 12 * H])


class BucketTest(unittest.TestCase):
    def test_last_value_per_key_per_column_at_its_minute(self):
        anchor = 0
        rows = [
            {"ts_minute": 10 * M, "payload": {"hr": 80, "spo2": 97}, "provenance": {}},
            {"ts_minute": 50 * M, "payload": {"hr": 90}, "provenance": {"hr": {"source": "manual"}}},
            {"ts_minute": 60 * M, "payload": {"hr": 95}, "provenance": {}},       # column 60 = (0, 60]
            {"ts_minute": 61 * M, "payload": {"hr": 100, "spo2": 99}, "provenance": {},
             "masked": {"nibp_sys": 300}},
        ]
        out = bucket_effective_rows(rows, 60, anchor)
        by_ts = {row["ts_minute"]: row for row in out}
        self.assertEqual(sorted(by_ts), [10 * M, 60 * M, 61 * M])
        self.assertEqual(by_ts[10 * M]["payload"], {"spo2": 97})
        self.assertEqual(by_ts[60 * M]["payload"], {"hr": 95})
        self.assertEqual(by_ts[61 * M]["payload"], {"hr": 100, "spo2": 99})
        self.assertEqual(by_ts[61 * M]["masked"], {"nibp_sys": 300})

    def test_provenance_follows_the_kept_value(self):
        rows = [{"ts_minute": 30 * M, "payload": {"hr": 90}, "provenance": {"hr": {"source": "manual"}}}]
        out = bucket_effective_rows(rows, 240, 0)
        self.assertEqual(out, [{"ts_minute": 30 * M, "payload": {"hr": 90}, "provenance": {"hr": {"source": "manual"}}}])

    def test_a_day_at_240_is_about_six_rows(self):
        rows = [{"ts_minute": i * M, "payload": {"hr": 60 + i % 30}, "provenance": {}} for i in range(1, 1441)]
        self.assertEqual(len(bucket_effective_rows(rows, 240, 0)), 6)


if __name__ == "__main__":
    unittest.main()
