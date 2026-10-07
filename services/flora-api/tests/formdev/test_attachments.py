"""Attachments (data layer: file storage): content-addressed uploads in the database or a directory, and records
that refuse references to files the server does not have."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from app.formdev.adapters.sqlite import SQLiteAdapter
from app.formdev.attachments import DatabaseAttachmentStore, FileAttachmentStore, refs
from app.formdev.errors import FormDevError
from helpers import USER, ready_services

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000")
SHA = hashlib.sha256(PNG).hexdigest()
FORM = {
    "format": "flora.form/1", "form_id": "wound_photo", "schema_version": 1, "title": "Wound photo", "paper": "A4", "style_id": "style.a4.medical",
    "sections": [{"id": "main", "title": "Main", "fields": [
        {"id": "hn", "type": "text", "label": "HN"},
        {"id": "photo", "type": "image", "label": "Photo", "multiple": True},
        {"id": "consent", "type": "file", "label": "Consent", "accept": ["application/pdf"]},
    ]}],
}


class StoreContract:
    """The same behaviour from both stores."""

    def make(self):  # pragma: no cover - overridden
        raise NotImplementedError

    def test_put_get_idempotent(self):
        store = self.make()
        self.assertFalse(store.exists(SHA))
        first = store.put(SHA, "image/png", PNG, USER)
        self.assertEqual((first["size"], first["created"]), (len(PNG), True))
        self.assertFalse(store.put(SHA, "image/png", PNG, USER)["created"])
        meta, content = store.get(SHA)
        self.assertEqual((meta["media_type"], content), ("image/png", PNG))
        self.assertTrue(store.exists(SHA))

    def test_refuses_wrong_hash_type_and_size(self):
        store = self.make()
        for sha, media_type, content, code in [
            (SHA, "image/png", PNG + b"x", "attachment_checksum"), ("ABC", "image/png", PNG, "invalid_attachment"),
            (SHA, "not a type", PNG, "invalid_attachment"),
        ]:
            with self.subTest(code):
                with self.assertRaises(FormDevError) as caught:
                    store.put(sha, media_type, content, USER)
                self.assertEqual(caught.exception.code, code)
        self.assertIsNone(store.get("0" * 64))
        self.assertFalse(store.exists("../etc/passwd"))


class DatabaseStore(StoreContract, unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        ready_services(self.adapter)

    def tearDown(self):
        self.adapter.close()

    def make(self):
        return DatabaseAttachmentStore(self.adapter)


class FileStore(StoreContract, unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.directory.cleanup()

    def make(self):
        return FileAttachmentStore(self.directory.name)

    def test_layout_is_sharded_with_a_sidecar(self):
        self.make().put(SHA, "image/png", PNG, USER)
        path = Path(self.directory.name) / SHA[:2] / SHA[2:4] / SHA
        self.assertEqual(path.read_bytes(), PNG)
        self.assertTrue(path.with_suffix(".json").is_file())
        self.assertEqual([item.name for item in path.parent.iterdir() if item.name.startswith("tmp")], [])


class Records(unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)
        self.fd.schemas.create_form(FORM, USER)
        self.fd.schemas.publish("wound_photo", 1, USER)

    def tearDown(self):
        self.adapter.close()

    def data(self):
        return {"hn": "HN1", "photo": [{"name": "wound.png", "mime": "image/png", "size": len(PNG), "ref": f"att:{SHA}"}]}

    def test_a_record_needs_its_files_uploaded_first(self):
        with self.assertRaises(FormDevError) as caught:
            self.fd.records.create("wound_photo", self.data(), USER)
        self.assertEqual([(item["path"], item["code"]) for item in caught.exception.details], [("$.data.photo[0]", "attachment_missing")])
        self.fd.attachments.put(SHA, "image/png", PNG, USER)
        saved = self.fd.records.create("wound_photo", self.data(), USER)
        self.assertEqual(saved["data"]["photo"][0]["ref"], f"att:{SHA}")

    def test_other_references_are_left_alone(self):
        data = {"hn": "HN1", "photo": [{"name": "old.png", "mime": "image/png", "size": 1, "ref": "pending:old.png"}]}
        self.assertEqual(self.fd.records.create("wound_photo", data, USER)["data"]["photo"][0]["ref"], "pending:old.png")

    def test_refs_walk_nested_data(self):
        data = {"a": {"name": "x", "ref": f"att:{SHA}"}, "rows": [{"f": [{"name": "y", "ref": f"att:{'1' * 64}"}]}], "b": {"ref": "att:bad"}}
        self.assertEqual([(path, sha) for path, sha, _ in refs(data)], [("$.data.a", SHA), ("$.data.rows[0].f[0]", "1" * 64)])


if __name__ == "__main__":
    unittest.main()
