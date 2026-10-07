"""Standalone bundle: build, verify, install into an empty standalone database, upgrade."""
import io
import json
import unittest
import zipfile

from app.formdev import services_for
from app.formdev.adapters.sqlite import SQLiteAdapter
from app.formdev.errors import FormDevError
from app.formdev.formpack import export_formpack, install_formpack, pack, read_formpack
from app.formdev.styles import pack_registry, stored_font
from helpers import FORMDEV_ROOT, USER, example, load_json

STYLES = {row["style_id"]: row for row in load_json("registry/styles.json")}
FONTS = {row["font_id"]: {"font_id": row["font_id"], "metadata": stored_font(row)} for row in load_json("registry/fonts.json")}


def registry_rows(definition: dict) -> tuple[list, list]:
    """Styles (with everything they inherit) and fonts a definition needs, as export_formpack picks them."""
    return pack_registry(definition, STYLES.__getitem__, FONTS.__getitem__)


def example_pack(version: int = 1, seed: bool = True) -> bytes:
    definition = example(version)
    assets = {"header.svg": (FORMDEV_ROOT / "examples/patient-assessment/assets/header.svg").read_bytes()}
    seed_rows = load_json("examples/patient-assessment/seed.records.json") if seed else None
    return pack(definition, *registry_rows(definition), assets, seed_rows)


def rewrite(data: bytes, path: str, content: bytes) -> bytes:
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as target:
        for name in source.namelist():
            target.writestr(name, content if name == path else source.read(name))
        if path not in source.namelist():
            target.writestr(path, content)
    return out.getvalue()


class FormpackTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = services_for(self.adapter)
        # Simulate a minimal host with an empty registry so the pack must bring its own.
        self.adapter._execute("DELETE FROM formdev_style")
        self.adapter._execute("DELETE FROM formdev_font")

    def tearDown(self):
        self.adapter.close()

    def install(self, data: bytes) -> dict:
        return install_formpack(data, self.fd.schemas, self.fd.styles, self.fd.records, USER)

    def test_build_is_deterministic_and_complete(self):
        first, second = example_pack(), example_pack()
        self.assertEqual(first, second)
        names = zipfile.ZipFile(io.BytesIO(first)).namelist()
        self.assertEqual(names[0], "manifest.json")
        self.assertEqual(sorted(names), sorted([
            "manifest.json", "form.json", "styles/form.a4.medical.json", "styles/style.a4.medical.json", "styles/style.a4.default.json",
            "styles/style.base.json", "fonts/noto-sans-thai.json",
            "assets/header.svg", "seed/records.json",
        ]))
        manifest = read_formpack(first)["manifest"]
        self.assertEqual((manifest["form_id"], manifest["schema_version"]), ("patient_assessment", 1))

    def test_install_into_empty_standalone_database(self):
        summary = self.install(example_pack())
        self.assertEqual(summary["definition"], "installed")
        self.assertEqual(summary["styles"], dict.fromkeys(["form.a4.medical", "style.a4.default", "style.a4.medical", "style.base"], "installed"))
        self.assertEqual(summary["fonts"], {"noto-sans-thai": "installed"})
        self.assertEqual(summary["seed_records"], {"created": 1, "skipped": 0})
        self.assertEqual(self.fd.schemas.latest_published("patient_assessment")["schema_version"], 1)
        self.assertEqual(self.adapter.get_asset("patient_assessment", "header.svg")["media_type"], "image/svg+xml")
        record = self.fd.records.get("6f1c1d1e-0000-4000-8000-000000000001")
        self.assertEqual(record["status"], "submitted")
        offline_record = self.fd.records.create("patient_assessment", {"hn": "LOCAL1"}, USER)
        self.assertEqual(offline_record["schema_version"], 1)

    def test_reinstall_is_a_no_op(self):
        self.install(example_pack())
        again = self.install(example_pack())
        self.assertEqual(again["definition"], "unchanged")
        self.assertEqual(again["styles"], dict.fromkeys(["form.a4.medical", "style.a4.default", "style.a4.medical", "style.base"], "unchanged"))
        self.assertEqual(again["seed_records"], {"created": 0, "skipped": 1})

    def test_upgrade_pack_migrates_installed_records(self):
        self.install(example_pack(1))
        self.install(example_pack(2, seed=False))
        view = self.fd.records.get("6f1c1d1e-0000-4000-8000-000000000001", as_version=2)
        self.assertEqual(view["data"]["fall_risk_level"], "high")
        self.assertEqual(view["data"]["weight_kg"], 61.5)

    def test_same_version_with_different_content_is_refused(self):
        self.install(example_pack())
        changed = example(1)
        changed["title"] = "Tampered but re-signed"
        package = pack(changed, [STYLES["form.a4.medical"]], [FONTS["noto-sans-thai"]])
        with self.assertRaises(FormDevError) as caught:
            self.install(package)
        self.assertEqual(caught.exception.code, "version_conflict")

    def test_tampered_file_is_rejected_and_nothing_is_installed(self):
        tampered = rewrite(example_pack(), "form.json", json.dumps(example(1) | {"title": "evil"}).encode())
        with self.assertRaises(FormDevError) as caught:
            self.install(tampered)
        self.assertIn("Checksum mismatch", caught.exception.message)
        self.assertEqual(self.fd.forms.list(), [])

    def test_unlisted_file_and_path_traversal_are_rejected(self):
        with self.assertRaises(FormDevError):
            self.install(rewrite(example_pack(), "assets/extra.txt", b"x"))
        with self.assertRaises(FormDevError):
            pack(example(1), [STYLES["form.a4.medical"]], [], {"../escape.txt": b"x"})
        with self.assertRaises(FormDevError):
            self.install(b"not a zip")

    def test_committed_example_packs_are_current_and_install_standalone(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("build_example_packs", FORMDEV_ROOT / "scripts/build_example_packs.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        built = builder.build()
        for name in ("patient-assessment.formpack", "patient-assessment.v2.formpack"):
            with self.subTest(name):
                self.assertEqual((FORMDEV_ROOT / "packs" / name).read_bytes(), built[name], "run formdev/scripts/build_example_packs.py")
                self.install(built[name])
        styles = {row["style_id"] for row in self.adapter.list_styles()}
        self.assertLessEqual({"form.a4.medical", "style.a4.medical", "style.a4.default", "style.base"}, styles)

    def test_export_round_trip_from_storage(self):
        self.install(example_pack())
        exported = read_formpack(export_formpack(self.fd.schemas, self.fd.styles, "patient_assessment"))
        self.assertEqual(exported["definition"], example(1))
        self.assertEqual(sorted(exported["assets"]), ["header.svg"])
        self.assertEqual([font["font_id"] for font in exported["fonts"]], ["noto-sans-thai"])


if __name__ == "__main__":
    unittest.main()
