"""Field-by-field copies of a case form (app/case_forms.py): stamping, merging, status and authors. No database."""
import os
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")

from app.case_forms import STATUS_KEY, copy_of, digest, merge, newest_author, stamp  # noqa: E402

LEAF = {"by": "nurse", "at": 10, "via": "leaf"}
CANOPY = {"by": "reviewer", "at": 20, "via": "canopy", "reason": "corrected"}


class Merge(unittest.TestCase):
    def test_stamp_marks_only_changed_fields_and_the_status(self):
        before = copy_of({"a": 1, "b": 2}, {"a": 1, "b": 1}, {}, "draft")
        after = stamp(before, {"a": 1, "b": 3}, "completed", 10, LEAF, {"a", "b"})
        self.assertEqual(after["versions"], {"a": 1, "b": 10, STATUS_KEY: 10})
        self.assertEqual(set(after["authors"]), {"b", STATUS_KEY})

    def test_the_newest_field_wins_with_its_author(self):
        leaf = copy_of({"a": "leaf", "b": "leaf"}, {"a": 10, "b": 30}, {"a": LEAF, "b": LEAF}, "draft")
        canopy = copy_of({"a": "canopy", "b": "canopy"}, {"a": 20, "b": 20}, {"a": CANOPY, "b": CANOPY}, "draft")
        merged, changed = merge(leaf, canopy)
        self.assertTrue(changed)
        self.assertEqual(merged["data"], {"a": "canopy", "b": "leaf"})
        self.assertEqual((merged["authors"]["a"]["via"], merged["authors"]["b"]["via"]), ("canopy", "leaf"))

    def test_a_removed_field_is_removed(self):
        local = copy_of({"a": 1}, {"a": 1}, {}, "draft")
        remote = copy_of({}, {"a": 5}, {}, "draft")
        self.assertEqual(merge(local, remote)[0]["data"], {})

    def test_status_follows_its_own_version(self):
        local = copy_of({}, {STATUS_KEY: 50}, {}, "completed")
        remote = copy_of({"a": 1}, {"a": 60, STATUS_KEY: 40}, {}, "draft")
        merged, _ = merge(local, remote)
        self.assertEqual((merged["status"], merged["versions"][STATUS_KEY]), ("completed", 50))
        merged, _ = merge(remote, local)
        self.assertEqual(merged["status"], "completed")

    def test_merging_is_idempotent_and_the_digest_identifies_the_copy(self):
        leaf = copy_of({"a": 1}, {"a": 10}, {"a": LEAF}, "draft")
        canopy = copy_of({"b": 2}, {"b": 20}, {"b": CANOPY}, "draft")
        once, _ = merge(leaf, canopy)
        twice, changed = merge(once, canopy)
        self.assertFalse(changed)
        self.assertEqual(digest(once), digest(twice))
        self.assertNotEqual(digest(once), digest(leaf))
        self.assertEqual(newest_author(once)["by"], "reviewer")


if __name__ == "__main__":
    unittest.main()
