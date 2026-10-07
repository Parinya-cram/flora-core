"""Query engine contract (Phase 4), run on SQLite and PostgreSQL with identical expectations."""
import os
import unittest
from urllib.parse import urlparse

from app.formdev.adapters.sql_query import QueryFailed, compile_plan
from app.formdev.adapters.sqlite import SQLiteAdapter
from app.formdev.errors import FormDevError
from app.formdev.query.access import Principal
from app.formdev.query.engine import QueryEngine, QueryRuntime
from app.formdev.query.plan import build_plan
from app.formdev.query.policy import policy
from helpers import USER, example, published_example, ready_services
from test_adapter_contract import FORMDEV_TABLES, MYSQL_READY, PG_URL, fresh_mysql

ADMIN = Principal(1, "admin", ("system_admin",), ("formdev.query", "formdev.export", "formdev.diagnostics", "formdev.manage"))
CLINICIAN = Principal(2, "nurse", ("clinician",), ("formdev.query",))
VIEWER = Principal(3, "auditor", ("viewer",), ("formdev.query",))
OTHER_VIEWER = Principal(4, "auditor2", ("viewer",), ("formdev.query",))

WARD_FORM = {
    "format": "flora.form/1", "form_id": "ward_check", "schema_version": 1, "title": "Ward check", "paper": "A4", "style_id": "form.a4.medical",
    "extensions": {"flora.subject_field": "hn"},
    "sections": [{"id": "main", "title": "Main", "fields": [
        {"id": "hn", "type": "text", "label": "HN", "indexed": True},
        {"id": "full_name", "type": "text", "label": "Name"},
        {"id": "ward", "type": "select", "label": "Ward", "indexed": True, "options": [{"value": "W1", "label": "W1"}, {"value": "W2", "label": "W2"}, {"value": "W3", "label": "W3"}]},
        {"id": "age", "type": "integer", "label": "Age", "indexed": True},
        {"id": "score", "type": "number", "label": "Score", "indexed": True},
        {"id": "smoker", "type": "checkbox", "label": "Smoker", "indexed": True},
        {"id": "seen_at", "type": "datetime", "label": "Seen", "indexed": True},
        {"id": "remarks", "type": "textarea", "label": "Remarks"},
    ]}],
}
REG_FORM = {
    "format": "flora.form/1", "form_id": "patient_registration", "schema_version": 1, "title": "Registration", "paper": "A4", "style_id": "form.a4.medical",
    "sections": [{"id": "main", "title": "Main", "fields": [
        {"id": "hn", "type": "text", "label": "HN", "indexed": True},
        {"id": "name", "type": "text", "label": "Name"},
        {"id": "phone", "type": "text", "label": "Phone"},
    ]}],
}


def ward_record(n):
    data = {"hn": f"HN-{n:04d}", "full_name": f"Patient {n}", "ward": f"W{n % 3 + 1}", "remarks": "x"}
    if n % 5:
        data["age"] = 20 + n
    if n % 4:
        data["score"] = n / 2
    data["smoker"] = n % 2 == 0
    data["seen_at"] = f"2026-10-{1 + n % 9:02d}T08:00:00+07:00" if n % 2 else f"2026-10-{1 + n % 9:02d}T01:00:00Z"
    return data


class QueryContract:
    N = 30

    def setUp(self):
        self.adapter = self.make_adapter()
        self.fd = ready_services(self.adapter)
        for definition in (WARD_FORM, REG_FORM):
            self.fd.schemas.create_form(definition, USER)
            self.fd.schemas.publish(definition["form_id"], 1, USER)
        self.records = [self.fd.records.create("ward_check", ward_record(n), USER, record_id=f"rec-{n:04d}-aaaa", updated_at=1_790_000_000_000 + n * 1000)
                        for n in range(self.N)]
        self.fd.records.delete("rec-0029-aaaa", 1, USER)
        self.adapter.save_form_policy({"form_id": "ward_check", "policy": {"fields": {"full_name": ["system_admin", "clinician"]}}, "version": 1, "updated_at": 0, "updated_by": USER})
        self.adapter.save_form_policy({"form_id": "patient_registration", "policy": {"fields": {"phone": ["system_admin"]}}, "version": 1, "updated_at": 0, "updated_by": USER})
        self.adapter.save_source({"source_id": "assessments", "form_id": "ward_check", "version": 1, "updated_at": 0, "updated_by": USER,
                                  "config": {"relations": {"patient": {"source": "patient_registration", "local": "hn", "foreign": "hn"}}}})
        for hn, name, status in (("HN-0001", "Draft name", "draft"), ("HN-0001", "Final name", "submitted"), ("HN-0002", "Only", "draft")):
            record = self.fd.records.create("patient_registration", {"hn": hn, "name": name, "phone": "081"}, USER)
            if status == "submitted":
                self.fd.records.submit(record["record_id"], {"hn": hn, "name": name, "phone": "081"}, 1, USER)
        self.runtime = QueryRuntime(cursor_secret=b"test-secret", test_hooks=True)

    def engine(self, principal=CLINICIAN, runtime=None):
        return QueryEngine(runtime or self.runtime, self.fd, principal)

    def run_query(self, principal=CLINICIAN, **query):
        query.setdefault("source", "ward_check")
        return self.engine(principal).run({"query": query})

    def ids(self, result):
        return [row["$record_id"] for row in result["rows"]]

    def live(self, predicate=lambda n, d: True):
        return {f"rec-{n:04d}-aaaa" for n in range(self.N - 1) if predicate(n, ward_record(n))}

    def collect(self, principal=CLINICIAN, **query):
        seen, cursor, pages = [], None, 0
        while True:
            pagination = {"mode": "cursor", "limit": 7}
            if cursor:
                pagination["cursor"] = cursor
            result = self.run_query(principal, pagination=pagination, cache=False, **query)
            seen += self.ids(result)
            pages += 1
            cursor = result["next_cursor"]
            if not cursor:
                return seen, pages

    # Filtering semantics -------------------------------------------------------------------
    def test_cursor_paging_returns_each_live_record_once_in_ingest_order(self):
        seen, pages = self.collect(select=["hn"])
        self.assertEqual(seen, [f"rec-{n:04d}-aaaa" for n in reversed(range(self.N - 1))])
        self.assertEqual(pages, 5)

    def test_filters_follow_the_documented_semantics(self):
        cases = [
            ({"field": "ward", "op": "eq", "value": "W2"}, lambda n, d: d["ward"] == "W2"),
            ({"field": "age", "op": "between", "value": [25, 35]}, lambda n, d: 25 <= d.get("age", -1) <= 35),
            ({"field": "age", "op": "ne", "value": 30}, lambda n, d: "age" in d and d["age"] != 30),
            ({"not": {"field": "age", "op": "eq", "value": 30}}, lambda n, d: d.get("age") != 30),
            ({"field": "age", "op": "is_null"}, lambda n, d: "age" not in d),
            ({"field": "score", "op": "is_not_null"}, lambda n, d: "score" in d),
            ({"field": "smoker", "op": "eq", "value": True}, lambda n, d: d["smoker"]),
            ({"field": "ward", "op": "in", "value": ["W1", "W3"]}, lambda n, d: d["ward"] in ("W1", "W3")),
            ({"or": [{"field": "ward", "op": "eq", "value": "W1"}, {"field": "age", "op": "gte", "value": 45}]}, lambda n, d: d["ward"] == "W1" or d.get("age", 0) >= 45),
            ({"or": [{"field": "$updated_by", "op": "eq", "value": "nobody"}, {"field": "score", "op": "lt", "value": 2}]}, lambda n, d: d.get("score", 99) < 2),
            ({"and": [{"field": "ward", "op": "eq", "value": "W1"}, {"not": {"field": "smoker", "op": "eq", "value": True}}]}, lambda n, d: d["ward"] == "W1" and not d["smoker"]),
            ({"field": "hn", "op": "prefix", "value": "HN-001"}, lambda n, d: d["hn"].startswith("HN-001")),
            ({"field": "hn", "op": "prefix", "value": "hn-001"}, lambda n, d: False),
            ({"field": "$subject_id", "op": "eq", "value": "HN-0007"}, lambda n, d: n == 7),
        ]
        for node, predicate in cases:
            with self.subTest(node):
                result = self.run_query(select=["hn"], filter=node, pagination={"mode": "offset", "limit": 100})
                self.assertEqual(set(self.ids(result)), self.live(predicate))

    def test_datetime_filters_compare_instants_across_offsets(self):
        start, end = "2026-10-03T00:00:00+07:00", "2026-10-05T23:59:59+07:00"
        from app.formdev.definition import datetime_epoch_ms

        lo, hi = datetime_epoch_ms(start), datetime_epoch_ms(end)
        result = self.run_query(select=["hn", "seen_at"], filter={"field": "seen_at", "op": "between", "value": [start, end]}, pagination={"mode": "offset", "limit": 100})
        self.assertEqual(set(self.ids(result)), self.live(lambda n, d: lo <= datetime_epoch_ms(d["seen_at"]) <= hi))

    def test_offset_sort_by_field_keeps_missing_values_last(self):
        for direction in ("asc", "desc"):
            with self.subTest(direction):
                result = self.run_query(select=["hn", "age"], sort=[{"field": "age", "dir": direction}], pagination={"mode": "offset", "limit": 100})
                ages = [row["age"] for row in result["rows"]]
                present = [age for age in ages if age is not None]
                self.assertEqual(present, sorted(present, reverse=direction == "desc"))
                self.assertEqual(ages[len(present):], [None] * (len(ages) - len(present)))
                page = self.run_query(select=["hn", "age"], sort=[{"field": "age", "dir": direction}], pagination={"mode": "offset", "limit": 5, "offset": 10})
                self.assertEqual(self.ids(page), self.ids(result)[10:15])

    def test_deleted_records_are_hidden_unless_an_admin_asks(self):
        self.assertNotIn("rec-0029-aaaa", self.ids(self.run_query(select=["hn"], pagination={"mode": "offset", "limit": 100})))
        with self.assertRaises(FormDevError) as caught:
            self.run_query(VIEWER, select=["hn"], filter={"field": "$status", "op": "eq", "value": "deleted"}, pagination={"mode": "offset", "limit": 10})
        self.assertEqual(caught.exception.details[0]["code"], "deleted_requires_admin")
        sneaky = self.run_query(VIEWER, select=["hn"], filter={"not": {"field": "$status", "op": "eq", "value": "draft"}}, pagination={"mode": "offset", "limit": 100})
        self.assertNotIn("rec-0029-aaaa", self.ids(sneaky))
        admin = self.run_query(ADMIN, select=["hn"], filter={"field": "$status", "op": "eq", "value": "deleted"}, pagination={"mode": "offset", "limit": 10})
        self.assertEqual(self.ids(admin), ["rec-0029-aaaa"])

    # Aggregates ------------------------------------------------------------------------------
    def test_group_and_aggregate(self):
        result = self.run_query(VIEWER, group=["ward"], aggregate=[{"fn": "count", "as": "n"}, {"fn": "avg", "field": "age", "as": "avg_age"},
                                                                   {"fn": "count", "field": "age", "as": "with_age"}, {"fn": "max", "field": "age", "as": "oldest"}])
        expected = {}
        for n in range(self.N - 1):
            d = ward_record(n)
            bucket = expected.setdefault(d["ward"], {"n": 0, "ages": []})
            bucket["n"] += 1
            if "age" in d:
                bucket["ages"].append(d["age"])
        self.assertEqual([row["ward"] for row in result["rows"]], ["W1", "W2", "W3"])
        for row in result["rows"]:
            ages = expected[row["ward"]]["ages"]
            self.assertEqual(row["n"], expected[row["ward"]]["n"])
            self.assertEqual(row["with_age"], len(ages))
            self.assertAlmostEqual(row["avg_age"], sum(ages) / len(ages))
            self.assertEqual(row["oldest"], max(ages))

    def test_group_by_metadata_bucket_and_sort_by_alias(self):
        by_status = self.run_query(VIEWER, group=["$status", "smoker"], aggregate=[{"fn": "count", "as": "n"}], sort=[{"field": "n", "dir": "desc"}])
        self.assertEqual(sum(row["n"] for row in by_status["rows"]), self.N - 1)
        self.assertEqual([row["n"] for row in by_status["rows"]], sorted((row["n"] for row in by_status["rows"]), reverse=True))
        self.assertTrue(all(isinstance(row["smoker"], bool) for row in by_status["rows"]))
        by_day = self.run_query(VIEWER, group=[{"field": "$ingested_at", "bucket": "day", "tz_offset_minutes": 420}], aggregate=[{"fn": "count", "as": "n"}])
        self.assertEqual(sum(row["n"] for row in by_day["rows"]), self.N - 1)
        self.assertRegex(by_day["rows"][0]["$ingested_at_day"], r"^\d{4}-\d{2}-\d{2}$")
        overall = self.run_query(VIEWER, aggregate=[{"fn": "sum", "field": "score", "as": "total"}, {"fn": "count", "as": "n"}])
        self.assertEqual(len(overall["rows"]), 1)
        self.assertAlmostEqual(overall["rows"][0]["total"], sum(ward_record(n).get("score", 0) for n in range(self.N - 1)))

    def test_large_aggregates_must_run_as_jobs(self):
        runtime = QueryRuntime(policy=policy({"interactive_aggregate_max_rows": 10}), cursor_secret=b"x")
        with self.assertRaises(FormDevError) as caught:
            self.engine(VIEWER, runtime).run({"query": {"source": "ward_check", "group": ["ward"], "aggregate": [{"fn": "count", "as": "n"}]}})
        self.assertEqual((caught.exception.code, caught.exception.status), ("full_scan_requires_job", 409))

    def test_capped_count(self):
        runtime = QueryRuntime(policy=policy({"count_cap": 10}), cursor_secret=b"x")
        result = self.engine(CLINICIAN, runtime).run({"query": {"source": "ward_check", "select": ["hn"], "count": "capped", "pagination": {"mode": "cursor", "limit": 5}}})
        self.assertEqual((result["total"], result["total_is_lower_bound"]), (10, True))
        exact = self.run_query(select=["hn"], filter={"field": "ward", "op": "eq", "value": "W1"}, count="capped", pagination={"mode": "cursor", "limit": 5})
        self.assertEqual((exact["total"], exact["total_is_lower_bound"]), (len(self.live(lambda n, d: d["ward"] == "W1")), False))

    # Relations and access ---------------------------------------------------------------------------
    def test_relation_lookup_prefers_submitted_and_reports_ambiguity(self):
        result = self.run_query(source="assessments", select=["hn", "patient.name"], filter={"field": "hn", "op": "in", "value": ["HN-0001", "HN-0002", "HN-0003"]},
                                pagination={"mode": "offset", "limit": 10})
        names = {row["hn"]: row["patient.name"] for row in result["rows"]}
        self.assertEqual(names, {"HN-0001": "Final name", "HN-0002": "Only", "HN-0003": None})
        self.assertEqual(result["relation_ambiguous"], {"patient": 1})

    def test_field_policy_is_enforced_in_every_clause(self):
        for query in ({"select": ["full_name"]}, {"select": ["hn"], "filter": {"field": "full_name", "op": "eq", "value": "x"}},
                      {"source": "assessments", "select": ["patient.phone"]}):
            with self.subTest(query):
                with self.assertRaises(FormDevError) as caught:
                    self.run_query(VIEWER, pagination={"mode": "offset", "limit": 5}, **query)
                self.assertIn("unauthorized_field", [issue["code"] for issue in caught.exception.details])
        allowed = self.run_query(CLINICIAN, select=["full_name"], pagination={"mode": "offset", "limit": 1})
        self.assertTrue(allowed["rows"][0]["full_name"].startswith("Patient"))
        audit = self.adapter.list_audit()
        self.assertTrue(any(row["action"] == "query" and "full_name" in row["fields"] for row in audit))
        self.assertFalse(any("Patient" in str(row) for row in audit), "audit rows never store values")

    def test_unknown_or_forbidden_sources_look_the_same(self):
        integration = Principal(9, "device", ("integration",), ())
        for principal, source in ((CLINICIAN, "nope"), (integration, "ward_check")):
            with self.assertRaises(FormDevError) as caught:
                self.engine(principal).run({"query": {"source": source, "select": ["hn"], "pagination": {"mode": "cursor", "limit": 5}}})
            self.assertEqual([issue["code"] for issue in caught.exception.details], ["unknown_source"])

    # Cache ------------------------------------------------------------------------------------------
    def test_cache_hits_and_is_invalidated_by_writes(self):
        query = {"source": "ward_check", "select": ["hn", "age"], "filter": {"field": "hn", "op": "eq", "value": "HN-0003"}, "pagination": {"mode": "offset", "limit": 5}}
        first = self.engine().run({"query": query})
        second = self.engine().run({"query": query})
        self.assertEqual((first["diagnostics"]["cache_hit"], second["diagnostics"]["cache_hit"]), (False, True))
        self.fd.records.update("rec-0003-aaaa", {**ward_record(3), "age": 99}, 1, USER)
        third = self.engine().run({"query": query})
        self.assertEqual((third["diagnostics"]["cache_hit"], third["rows"][0]["age"]), (False, 99))
        refreshed = self.engine().run({"query": query}, refresh=True)
        self.assertFalse(refreshed["diagnostics"]["cache_hit"])
        policy_change = {"form_id": "ward_check", "policy": {"fields": {"full_name": ["system_admin"], "age": ["system_admin"]}}, "version": 2, "updated_at": 1, "updated_by": USER}
        self.adapter.save_form_policy(policy_change)
        with self.assertRaises(FormDevError):
            self.engine().run({"query": query})

    # Cursors ------------------------------------------------------------------------------------------
    def test_cursors_are_signed_and_bound_to_query_and_user(self):
        page = self.run_query(select=["hn"], pagination={"mode": "cursor", "limit": 3})
        token = page["next_cursor"]
        payload, signature = token.split(".")
        tampered = payload[:-2] + ("A" if payload[-2] != "A" else "B") + payload[-1] + "." + signature
        attempts = [
            (CLINICIAN, {"select": ["hn"]}, tampered),
            (CLINICIAN, {"select": ["hn"]}, "garbage"),
            (CLINICIAN, {"select": ["hn", "age"]}, token),
            (CLINICIAN, {"select": ["hn"], "filter": {"field": "ward", "op": "eq", "value": "W1"}}, token),
        ]
        for principal, query, cursor in attempts:
            with self.subTest(cursor[:12]):
                with self.assertRaises(FormDevError) as caught:
                    self.run_query(principal, pagination={"mode": "cursor", "limit": 3, "cursor": cursor}, **query)
                self.assertEqual((caught.exception.code, caught.exception.status), ("invalid_cursor", 400))
        other = QueryEngine(self.runtime, self.fd, Principal(5, "other", ("clinician",), ("formdev.query",)))
        with self.assertRaises(FormDevError):
            other.run({"query": {"source": "ward_check", "select": ["hn"], "pagination": {"mode": "cursor", "limit": 3, "cursor": token}}})

    # Limits, timeouts, failures ----------------------------------------------------------------------
    def test_timeouts_are_friendly_and_leave_the_connection_usable(self):
        query = {"source": "ward_check", "select": ["hn"], "timeout": 150, "pagination": {"mode": "cursor", "limit": 5}}
        with self.assertRaises(FormDevError) as caught:
            self.engine().run({"query": query}, test_sleep_ms=3000)
        error = caught.exception
        self.assertEqual((error.code, error.status), ("query_timeout", 504))
        self.assertNotIn("select", error.message.lower())
        after = self.engine().run({"query": {**query, "timeout": 5000}})
        self.assertEqual(len(after["rows"]), 5)
        self.assert_connection_clean()

    def assert_connection_clean(self):
        pass

    def test_read_sessions_cannot_write(self):
        from app.formdev.adapters.sql_query import CompiledQuery

        with self.assertRaises(QueryFailed):
            with self.adapter.read_session(1000) as session:
                session.fetch(CompiledQuery("DELETE FROM formdev_record WHERE record_id = ?", ("rec-0001-aaaa",)))
        self.assertIsNotNone(self.adapter.get_record("rec-0001-aaaa"))

    def test_result_size_is_capped(self):
        runtime = QueryRuntime(policy=policy({"max_result_bytes": 500}), cursor_secret=b"x")
        with self.assertRaises(FormDevError) as caught:
            self.engine(CLINICIAN, runtime).run({"query": {"source": "ward_check", "select": ["hn", "full_name", "remarks"], "pagination": {"mode": "cursor", "limit": 50}}})
        self.assertEqual(caught.exception.code, "result_too_large")

    def test_diagnostics_need_permission_and_never_contain_values(self):
        query = {"query": {"source": "ward_check", "select": ["hn"], "filter": {"field": "hn", "op": "eq", "value": "HN-0005"}, "pagination": {"mode": "cursor", "limit": 5}}}
        with self.assertRaises(FormDevError) as caught:
            self.engine(VIEWER).run(query, explain=True)
        self.assertEqual(caught.exception.status, 403)
        plain = self.engine(VIEWER).run(query)
        self.assertNotIn("sql", plain["diagnostics"])
        admin = self.engine(ADMIN).run(query, explain=True, refresh=True)
        diagnostics = admin["diagnostics"]
        self.assertTrue(diagnostics["plan"]["indexes_used"])
        self.assertNotIn("HN-0005", str(diagnostics))

    def test_user_values_never_reach_the_sql_text(self):
        hostile = "x'); DROP TABLE formdev_record; --"
        issues, spec, catalog = self.engine().validate({"query": {"source": "ward_check", "select": ["hn"], "filter": {"or": [
            {"field": "hn", "op": "eq", "value": hostile}, {"field": "hn", "op": "prefix", "value": hostile}, {"field": "$created_by", "op": "in", "value": [hostile]}]},
            "pagination": {"mode": "cursor", "limit": 5}}})
        compiled = compile_plan(build_plan(spec))
        self.assertNotIn("DROP", compiled.sql)
        self.assertIn(hostile, compiled.params)
        self.assertEqual(self.engine().run({"query": {"source": "ward_check", "select": ["hn"], "filter": {"field": "hn", "op": "eq", "value": hostile}, "pagination": {"mode": "cursor", "limit": 5}}})["rows"], [])

    # Schema versions ----------------------------------------------------------------------------------
    def test_old_schema_records_are_projected_with_the_latest_names(self):
        published_example(self.fd)
        old = self.fd.records.create("patient_assessment", {"hn": "HN-OLD", "bp": 140, "weight": "70", "fall_risk": "yes"}, USER)
        self.fd.schemas.save_draft(example(2), USER)
        self.fd.schemas.publish("patient_assessment", 2, USER)
        new = self.fd.records.create("patient_assessment", {"hn": "HN-NEW", "bp_sys": 120, "weight_kg": 60, "fall_risk_level": "low"}, USER)
        result = self.engine(ADMIN).run({"query": {"source": "patient_assessment", "select": ["hn", "bp_sys", "weight_kg", "fall_risk_level", "$schema_version"],
                                                    "filter": {"field": "fall_risk_level", "op": "in", "value": ["high", "low"]}, "pagination": {"mode": "offset", "limit": 10}}})
        rows = {row["$record_id"]: row for row in result["rows"]}
        self.assertEqual({k: rows[old["record_id"]][k] for k in ("bp_sys", "weight_kg", "fall_risk_level", "$schema_version")}, {"bp_sys": 140, "weight_kg": 70, "fall_risk_level": "high", "$schema_version": 1})
        self.assertEqual(rows[new["record_id"]]["fall_risk_level"], "low")


    # Phase 4 review, group E ---------------------------------------------------------------------
    def test_cached_pages_carry_a_cursor_for_each_caller(self):
        """security:10 / spec:3 — callers with the same roles share the cache, not the signed cursor."""
        query = {"select": ["hn"], "pagination": {"mode": "cursor", "limit": 5}}
        first = self.run_query(VIEWER, **query)
        second = self.run_query(OTHER_VIEWER, **query)
        self.assertTrue(second["diagnostics"]["cache_hit"])
        self.assertNotEqual(first["next_cursor"], second["next_cursor"])
        page_two = self.run_query(OTHER_VIEWER, select=["hn"], pagination={"mode": "cursor", "limit": 5, "cursor": second["next_cursor"]})
        self.assertEqual(len(page_two["rows"]), 5)
        self.assertTrue(set(self.ids(page_two)).isdisjoint(self.ids(second)))
        again = self.run_query(VIEWER, **query)
        self.run_query(VIEWER, select=["hn"], pagination={"mode": "cursor", "limit": 5, "cursor": again["next_cursor"]})

    def test_not_keeps_records_without_a_subject(self):
        """sql-correctness:0 — NOT over $subject_id behaves like NOT over the subject field."""
        self.fd.records.create("ward_check", {"ward": "W1"}, USER, record_id="no-subject-0001")
        by_meta = self.run_query(select=["hn"], filter={"not": {"field": "$subject_id", "op": "eq", "value": "HN-0007"}}, pagination={"mode": "offset", "limit": 100})
        by_field = self.run_query(select=["hn"], filter={"not": {"field": "hn", "op": "eq", "value": "HN-0007"}}, pagination={"mode": "offset", "limit": 100})
        self.assertIn("no-subject-0001", self.ids(by_meta))
        self.assertEqual(sorted(self.ids(by_meta)), sorted(self.ids(by_field)))
        prefix = self.run_query(select=["hn"], filter={"not": {"field": "$subject_id", "op": "prefix", "value": "HN-00"}}, pagination={"mode": "offset", "limit": 100})
        self.assertEqual(self.ids(prefix), ["no-subject-0001"])

    def test_relation_keys_follow_the_foreign_column(self):
        """sql-correctness:1 — an integer local key matches a text foreign key on every vendor (no 500)."""
        self.fd.records.create("patient_registration", {"hn": "21", "name": "Twenty-one"}, USER)
        self.adapter.save_source({"source_id": "by_age", "form_id": "ward_check", "version": 1, "updated_at": 0, "updated_by": USER,
                                  "config": {"relations": {"reg": {"source": "patient_registration", "local": "age", "foreign": "hn"}}}})
        result = self.run_query(ADMIN, source="by_age", select=["hn", "age", "reg.name"], filter={"field": "hn", "op": "in", "value": ["HN-0001", "HN-0002"]},
                                sort=[{"field": "$record_id", "dir": "asc"}], pagination={"mode": "cursor", "limit": 5})
        self.assertEqual([(row["age"], row["reg.name"]) for row in result["rows"]], [(21, "Twenty-one"), (22, None)])

    def test_relation_candidates_are_ranked_in_the_database(self):
        """spec:12 — a non-unique key returns at most two candidates, and the ranking still picks the best."""
        from app.formdev.adapters.sql_query import relation_lookup

        for n in range(6):
            self.fd.records.create("patient_registration", {"hn": "HN-0003", "name": f"Duplicate {n}"}, USER)
        with self.adapter.read_session(5000) as session:
            rows = session.fetch(relation_lookup("patient_registration", "hn", "value_text", ["HN-0003", "HN-0001"]))
        self.assertEqual(sorted((row["relation_key"], int(row["relation_rank"])) for row in rows),
                         [("HN-0001", 1), ("HN-0001", 2), ("HN-0003", 1), ("HN-0003", 2)])
        result = self.run_query(ADMIN, source="assessments", select=["hn", "patient.name"], filter={"field": "hn", "op": "in", "value": ["HN-0001", "HN-0003"]},
                                sort=[{"field": "$record_id", "dir": "asc"}], pagination={"mode": "cursor", "limit": 5})
        self.assertEqual(result["rows"][0]["patient.name"], "Final name", "submitted first")
        self.assertEqual(result["relation_ambiguous"], {"patient": 2})

    def test_datetime_min_and_max_are_instants(self):
        """sql-correctness:2 — not epoch milliseconds."""
        result = self.run_query(ADMIN, aggregate=[{"fn": "min", "field": "seen_at", "as": "first"}, {"fn": "max", "field": "seen_at", "as": "last"}])
        self.assertEqual(result["rows"], [{"first": "2026-10-01T01:00:00.000Z", "last": "2026-10-09T01:00:00.000Z"}])

    def test_explain_is_never_answered_from_the_cache(self):
        """spec:14 — diagnostics need the plan, which a cached result does not have."""
        query = {"select": ["hn"], "filter": {"field": "ward", "op": "eq", "value": "W1"}, "pagination": {"mode": "cursor", "limit": 5}}
        self.engine(ADMIN).run({"query": {"source": "ward_check", **query}})
        explained = self.engine(ADMIN).run({"query": {"source": "ward_check", **query}}, explain=True)
        self.assertFalse(explained["diagnostics"]["cache_hit"])
        self.assertIn("plan", explained["diagnostics"])


    # Phase 4 review, group G -------------------------------------------------------------------
    def test_statistics_flush_and_drive_the_advisor(self):
        """spec:16 — refused queries are recorded by shape, flushed additively and read back by the advisor."""
        from app.formdev.query.advisor import advise
        from app.formdev.query.catalog import build_catalog

        for _ in range(3):
            with self.assertRaises(FormDevError):
                self.run_query(ADMIN, select=["hn"], filter={"field": "full_name", "op": "eq", "value": "Patient 3"}, pagination={"mode": "cursor", "limit": 5})
        self.run_query(ADMIN, select=["hn"], filter={"field": "ward", "op": "eq", "value": "W1"}, pagination={"mode": "cursor", "limit": 5})

        def write(rows):
            with self.adapter.transaction():
                self.adapter.flush_query_stats(rows)

        self.assertEqual(self.runtime.stats.flush(write), 2)
        self.run_query(ADMIN, select=["hn"], filter={"field": "ward", "op": "eq", "value": "W2"}, pagination={"mode": "cursor", "limit": 5})
        self.assertEqual(self.runtime.stats.flush(write), 1)
        stats = self.adapter.list_query_stats("ward_check")
        by_runs = sorted((row["runs"], row["ok"], row["rejected"]) for row in stats)
        self.assertEqual(by_runs, [(2, 2, 0), (3, 0, 3)], "the second flush adds to the same shape")
        self.assertEqual(next(row for row in stats if row["rejected"])["shape"]["rejected_not_indexed"], ["full_name"])
        advice = advise(build_catalog(self.fd, "ward_check"), stats, self.adapter.count_records("ward_check"), self.adapter.vendor)
        self.assertIn(("index_field", "full_name"), {(item["kind"], item.get("field")) for item in advice})


    # Performance review (1M benchmark): the LIMIT trap ---------------------------------------------
    def test_filter_first_pages_equal_order_first_pages(self):
        """Both list strategies return the same pages (keyset paging included); the probe picks filter-first when
        matches are sparse among the next pages of records."""
        import dataclasses

        from app.formdev.adapters.sql_query import SqlQueryCompiler
        from app.formdev.query.plan import build_plan

        filters = [
            {"field": "ward", "op": "eq", "value": "W2"},
            {"field": "seen_at", "op": "between", "value": ["2026-10-02T00:00:00Z", "2026-10-05T00:00:00Z"]},
            {"or": [{"field": "$subject_id", "op": "eq", "value": "HN-0007"}, {"field": "ward", "op": "eq", "value": "W3"}]},
            {"and": [{"not": {"field": "smoker", "op": "eq", "value": True}}, {"field": "age", "op": "gte", "value": 30}]},
            {"field": "$created_at", "op": "gte", "value": "2026-01-01T00:00:00Z"},
        ]
        engine = self.engine(ADMIN)
        for node in filters:
            _, spec, _ = engine.require_valid({"query": {"source": "ward_check", "select": ["hn"], "filter": node, "pagination": {"mode": "cursor", "limit": 4}}})
            keyset, pages = None, {"order": [], "filter": []}
            for drive in ("order", "filter"):
                keyset = None
                while True:
                    plan = dataclasses.replace(build_plan(spec, keyset), drive=drive)
                    self.assertTrue(SqlQueryCompiler(plan).can_drive_by_filter(), node)
                    with self.adapter.read_session(5000) as session:
                        rows = session.fetch(compile_plan(plan))
                    pages[drive].append([row["record_id"] for row in rows[: plan.limit]])
                    if len(rows) <= plan.limit:
                        break
                    keyset = (rows[plan.limit - 1]["order_value"],)
            self.assertEqual(pages["order"], pages["filter"], node)
            self.assertGreater(sum(map(len, pages["order"])), 0, node)
        with self.adapter.read_session(5000) as session:
            dense = build_plan(engine.require_valid({"query": {"source": "ward_check", "select": ["hn"], "filter": {"field": "ward", "op": "in", "value": ["W1", "W2", "W3"]},
                                                              "pagination": {"mode": "cursor", "limit": 2}}})[1])
            self.assertGreater(int(session.fetch(SqlQueryCompiler(dense).density_probe())[0]["hits"]), dense.limit)


class SQLiteQueryContract(QueryContract, unittest.TestCase):
    def make_adapter(self):
        return SQLiteAdapter(":memory:")

    def tearDown(self):
        self.adapter.close()


@unittest.skipUnless(PG_URL and urlparse(PG_URL).path.endswith("_test"), "set FORMDEV_PG_TEST_URL to a *_test database")
class PostgreSQLQueryContract(QueryContract, unittest.TestCase):
    def make_adapter(self):
        import psycopg
        from psycopg.rows import dict_row

        from app.formdev.adapters.postgres import PostgreSQLAdapter

        self.connection = psycopg.connect(PG_URL, autocommit=True, row_factory=dict_row)
        self.connection.execute("ALTER TABLE formdev_schema_version DISABLE TRIGGER formdev_schema_version_immutable")
        for table in FORMDEV_TABLES:
            self.connection.execute(f"DELETE FROM {table}")
        self.connection.execute("ALTER TABLE formdev_schema_version ENABLE TRIGGER formdev_schema_version_immutable")
        return PostgreSQLAdapter(self.connection)

    def assert_connection_clean(self):
        from psycopg.pq import TransactionStatus

        self.assertEqual(self.connection.info.transaction_status, TransactionStatus.IDLE)
        self.assertEqual(self.connection.execute("SHOW statement_timeout").fetchone()["statement_timeout"], "0")
        self.assertEqual(self.connection.execute("SELECT 1 AS ok").fetchone()["ok"], 1)
        lingering = self.connection.execute("SELECT count(*) AS n FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep%%' AND state = 'active'").fetchone()["n"]
        self.assertEqual(lingering, 0)

    def tearDown(self):
        self.connection.close()


@unittest.skipUnless(MYSQL_READY, "set FORMDEV_MYSQL_TEST_URL to a *_test database")
class MySQLQueryContract(QueryContract, unittest.TestCase):
    def make_adapter(self):
        return fresh_mysql()

    def assert_connection_clean(self):
        rows = self.adapter._rows(self.adapter._raw("SELECT @@SESSION.max_execution_time AS limit_ms, (SELECT COUNT(*) FROM information_schema.innodb_trx "
                                                    "WHERE trx_mysql_thread_id = CONNECTION_ID()) AS open_tx"))
        self.assertEqual((int(rows[0]["limit_ms"]), int(rows[0]["open_tx"])), (0, 0))

    def tearDown(self):
        self.adapter.close()


if __name__ == "__main__":
    unittest.main()
