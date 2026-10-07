"""Phase 4 review, group B: saved-query access (security:7, spec:9), bodies read before any slot or
connection (security:8), paging saved queries written with the limit alias (spec:7) and PUT /sources
rolling back on any refused relation (spec:8). Endpoints are called directly (no HTTP client here)."""
import asyncio
import os
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.access import Principal  # noqa: E402
from app.formdev.query.engine import QueryRuntime  # noqa: E402
from app.routes import formdev_query as routes  # noqa: E402
from helpers import USER, ready_services  # noqa: E402
from test_query_engine import ADMIN, CLINICIAN, REG_FORM, VIEWER, WARD_FORM, ward_record  # noqa: E402

NO_QUERY = Principal(7, "clerk", ("clerk",), ())
SECRET_FILTER = {"and": [{"field": "hn", "op": "eq", "value": "HN-0001"}, {"field": "age", "op": "gte", "value": 40}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)
        for definition in (WARD_FORM, REG_FORM):
            self.fd.schemas.create_form(definition, USER)
            self.fd.schemas.publish(definition["form_id"], 1, USER)
        for n in range(1, 13):
            self.fd.records.create("ward_check", ward_record(n), USER, record_id=f"rec-{n:04d}-aaaa")
        self.runtime = QueryRuntime(cursor_secret=b"t")

    def tearDown(self):
        self.adapter.close()

    def ctx(self, principal):
        return routes.Context(self.runtime, self.fd, principal)

    def save(self, query_id, owner, query):
        self.adapter.save_saved_query({"query_id": query_id, "definition": {"query": {"id": query_id, **query}}, "owner_user_id": owner.user_id,
                                       "owner": owner.username, "created_at": 0, "updated_at": 0})


class SavedQueryAccess(Base):
    def setUp(self):
        super().setUp()
        self.save("nurse_ward", CLINICIAN, {"source": "ward_check", "select": ["hn"], "filter": SECRET_FILTER})
        self.save("nurse_reg", CLINICIAN, {"source": "patient_registration", "select": ["hn"]})
        self.adapter.save_form_policy({"form_id": "patient_registration", "policy": {"query": ["clinician"]}, "version": 1, "updated_at": 0, "updated_by": USER})

    def ids(self, principal):
        return [row["query_id"] for row in routes.list_saved(self.ctx(principal))["rows"]]

    def test_formdev_query_is_required(self):
        for call in (lambda c: routes.list_saved(c), lambda c: routes.get_saved("nurse_ward", c)):
            with self.assertRaises(FormDevError) as caught:
                call(self.ctx(NO_QUERY))
            self.assertEqual(caught.exception.status, 403)

    def test_only_owned_or_queryable_sources_are_listed(self):
        self.assertEqual(sorted(self.ids(CLINICIAN)), ["nurse_reg", "nurse_ward"])
        self.assertEqual(self.ids(VIEWER), ["nurse_ward"], "the registration source is not queryable by viewers")
        self.assertEqual(sorted(self.ids(ADMIN)), ["nurse_reg", "nurse_ward"])
        with self.assertRaises(FormDevError) as caught:
            routes.get_saved("nurse_reg", self.ctx(VIEWER))
        self.assertEqual(caught.exception.code, "query_not_found", "hidden, not forbidden: its existence is not revealed")
        with self.assertRaises(FormDevError):
            asyncio.run(routes.run_saved("nurse_reg", {}, self.ctx(VIEWER)))

    def test_filter_values_are_removed_for_others(self):
        other = routes.get_saved("nurse_ward", self.ctx(VIEWER))["query"]
        self.assertTrue(other["redacted"])
        leaves = other["definition"]["query"]["filter"]["and"]
        self.assertEqual([(leaf["field"], leaf["op"], leaf["value"]) for leaf in leaves], [("hn", "eq", None), ("age", "gte", None)])
        own = routes.get_saved("nurse_ward", self.ctx(CLINICIAN))["query"]
        self.assertEqual(own["definition"]["query"]["filter"], SECRET_FILTER)
        self.assertNotIn("redacted", own)
        self.assertEqual(self.adapter.get_saved_query("nurse_ward")["definition"]["query"]["filter"], SECRET_FILTER, "stored copy untouched")


class SavedQueryPaging(Base):
    def test_the_limit_alias_pages(self):
        self.save("first_ten", CLINICIAN, {"source": "ward_check", "select": ["hn"], "limit": 10})
        first = asyncio.run(routes.run_saved("first_ten", None, self.ctx(CLINICIAN)))
        self.assertEqual(len(first["rows"]), 10)
        self.assertTrue(first["next_cursor"])
        second = asyncio.run(routes.run_saved("first_ten", {"cursor": first["next_cursor"]}, self.ctx(CLINICIAN)))
        self.assertEqual(len(second["rows"]), 2)

    def test_an_existing_pagination_object_keeps_its_limit(self):
        self.save("pages_of_five", CLINICIAN, {"source": "ward_check", "select": ["hn"], "pagination": {"mode": "cursor", "limit": 5}})
        first = asyncio.run(routes.run_saved("pages_of_five", {}, self.ctx(CLINICIAN)))
        second = asyncio.run(routes.run_saved("pages_of_five", {"cursor": first["next_cursor"]}, self.ctx(CLINICIAN)))
        self.assertEqual((len(first["rows"]), len(second["rows"])), (5, 5))


class SourceRollback(Base):
    def put(self, relations):
        return asyncio.run(routes.save_source("assessments", {"form_id": "ward_check", "config": {"relations": relations}}, self.ctx(ADMIN)))

    def test_an_unknown_relation_target_keeps_the_previous_source(self):
        good = {"patient": {"source": "patient_registration", "local": "hn", "foreign": "hn"}}
        self.put(good)
        with self.assertRaises(FormDevError):
            self.put({"patient": {"source": "no_such_source", "local": "hn", "foreign": "hn"}})
        stored = self.adapter.get_source("assessments")
        self.assertEqual((stored["version"], stored["config"]["relations"]), (1, good))
        self.assertIsNotNone(self.ctx(ADMIN).engine().catalog("assessments"))

    def test_a_refused_new_source_is_not_kept(self):
        with self.assertRaises(FormDevError):
            self.put({"patient": {"source": "no_such_source", "local": "hn", "foreign": "hn"}})
        self.assertIsNone(self.adapter.get_source("assessments"))


class BodiesFirst(unittest.TestCase):
    def test_bodies_are_resolved_before_the_context(self):
        """security:8 — the body dependency precedes the rate token, slot and pooled connection."""
        checked = 0
        for route in routes.router.routes:
            names = [getattr(dep.call, "__name__", "") for dep in route.dependant.dependencies]
            source = route.endpoint.__code__.co_names
            self.assertNotIn("read_json", source, f"{route.path} reads its body after the context")
            if "json_body" in names:
                checked += 1
                context = next(i for i, name in enumerate(names) if name in ("api_context", "query_context"))
                self.assertLess(names.index("json_body"), context, route.path)
        self.assertEqual(checked, 7)

    def test_a_slow_body_times_out(self):
        class Slow:
            headers = {"content-length": "100"}

            async def stream(self):
                yield b"{"
                await asyncio.sleep(5)
                yield b"}"

        with self.assertRaises(FormDevError) as caught:
            asyncio.run(routes.read_json(Slow(), deadline=0.05))
        self.assertEqual((caught.exception.code, caught.exception.status), ("body_timeout", 408))

    def test_oversized_bodies(self):
        class Big:
            headers = {}

            async def stream(self):
                yield b"x" * 70000

        with self.assertRaises(FormDevError) as caught:
            asyncio.run(routes.read_json(Big()))
        self.assertEqual(caught.exception.code, "body_too_large")


if __name__ == "__main__":
    unittest.main()
