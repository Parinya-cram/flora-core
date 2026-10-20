"""What keeps the database from growing for ever: the device import audit written once an hour while nothing changes
(not every minute for every case) and pruned after its days, and old sync message payloads emptied (their rows kept,
so a message sent again is still recognised). The second part needs a disposable database (scripts/test-leaf-writes.sh)."""
import json
import os
import secrets
import time
import unittest
import uuid
from urllib.parse import urlparse

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")

from app.device_writer import DeviceWriter  # noqa: E402


class Database:
    def __init__(self):
        self.sql = []

    def execute(self, sql, params=()):
        self.sql.append((" ".join(sql.split())[:40], params))


class DeviceAudit(unittest.TestCase):
    def setUp(self):
        DeviceWriter._audit_last.clear()
        DeviceWriter._audit_pruned = 0

    def test_the_same_failure_is_written_once_an_hour_and_a_change_at_once(self):
        database, case = Database(), {"id": 7, "hn": "HN1"}
        for minute in range(5):
            DeviceWriter._audit(database, case, "http://vector", minute, 0, 0, "failed", "connection refused")
        inserts = [sql for sql, _ in database.sql if sql.startswith("INSERT")]
        self.assertEqual(len(inserts), 1, "five minutes of the same failure: one row")
        self.assertEqual(sum(sql.startswith("DELETE") for sql, _ in database.sql), 1, "old rows pruned, once an hour")
        DeviceWriter._audit(database, case, "http://vector", 5, 3, 3, "ok", None)
        DeviceWriter._audit(database, case, "http://vector", 6, 0, 0, "failed", "connection refused")
        self.assertEqual(sum(sql.startswith("INSERT") for sql, _ in database.sql), 3, "recovering and failing again are written")
        DeviceWriter._audit_last[7] = ("failed", "connection refused", int(time.time() * 1000) - 3601 * 1000)
        DeviceWriter._audit(database, case, "http://vector", 7, 0, 0, "failed", "connection refused")
        self.assertEqual(sum(sql.startswith("INSERT") for sql, _ in database.sql), 4, "an hour later it is written again")


URL = os.environ.get("FLORA_DATABASE_URL", "")


@unittest.skipUnless(urlparse(URL).path.endswith("_test"), "needs a disposable database ending in _test")
class SyncMessages(unittest.TestCase):
    def test_old_payloads_are_emptied_and_the_rows_kept(self):
        import psycopg
        from psycopg.rows import dict_row
        from psycopg.types.json import Jsonb

        from app.routes import sync_ingest

        with psycopg.connect(URL, autocommit=True, row_factory=dict_row) as database:
            leaf = f"leaf-retention-{secrets.token_hex(3)}"
            database.execute("INSERT INTO sync_leaf_node (leaf_id, hospital_id, display_name) VALUES (%s, 'h', 'r')", (leaf,))
            ids = {"old": str(uuid.uuid4()), "new": str(uuid.uuid4())}
            for message, age in (("old", "40 days"), ("new", "1 day")):
                database.execute("""INSERT INTO sync_message (leaf_id, message_id, entity_type, entity_id, operation, revision, occurred_at, payload, received_at)
                                    VALUES (%s, %s, 'case_snapshot', '1', 'upsert', 1, now(), %s, now() - %s::interval)""",
                                 (leaf, ids[message], Jsonb({"case": {"hn": "HN1"}, "pad": "x" * 2000}), age))
            sync_ingest.compact_messages(database)
            names = {value: key for key, value in ids.items()}
            rows = {names[str(row["message_id"])]: row["payload"] for row in database.execute("SELECT message_id, payload FROM sync_message WHERE leaf_id=%s", (leaf,))}
            self.assertEqual(rows["old"], {}, "an old payload is emptied")
            self.assertEqual(json.loads(json.dumps(rows["new"]))["case"]["hn"], "HN1", "a recent one is kept")
            self.assertEqual(len(rows), 2, "the rows stay: a message sent again is still a duplicate")


if __name__ == "__main__":
    unittest.main()
