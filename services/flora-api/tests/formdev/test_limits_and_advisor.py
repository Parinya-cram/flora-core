"""Phase 4.11 limits and the 4.6 index advisor (Phase 4 review, group G: spec:6, spec:16).

Rate and concurrency limits, the order in which a query request takes them (token, then slot, then pooled
connection: a refused request never holds a connection), the advisor's recommendations and the statistics
flush. The flush round trip on every storage vendor is in test_query_engine (QueryContract)."""
import os
import unittest
from contextlib import contextmanager

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.advisor import LARGE_FORM_RECORDS, advise, partial_index_ddl, usage  # noqa: E402
from app.formdev.query.catalog import SourceCatalog  # noqa: E402
from app.formdev.query.engine import QueryRuntime  # noqa: E402
from app.formdev.query.limits import ConcurrencyLimiter, RateLimiter  # noqa: E402
from app.formdev.query.policy import policy  # noqa: E402
from app.formdev.query.stats import StatsCollector  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class RateLimits(unittest.TestCase):
    def test_burst_then_refill(self):
        clock = Clock()
        limiter = RateLimiter(per_minute=60, burst=3, clock=clock)
        for _ in range(3):
            limiter.take("u1")
        with self.assertRaises(FormDevError) as caught:
            limiter.take("u1")
        self.assertEqual((caught.exception.code, caught.exception.status, caught.exception.details["retry_after"]), ("rate_limited", 429, 1))
        limiter.take("u2")  # other users have their own bucket
        clock.now += 1.0  # one token per second
        limiter.take("u1")
        with self.assertRaises(FormDevError):
            limiter.take("u1")

    def test_retry_after_is_enough_and_costs_count(self):
        clock = Clock()
        limiter = RateLimiter(per_minute=6, burst=1, clock=clock)  # one token every 10 s
        limiter.take("u", 0.2)
        limiter.take("u", 0.8)
        with self.assertRaises(FormDevError) as caught:
            limiter.take("u")
        wait = caught.exception.details["retry_after"]
        self.assertEqual(wait, 10)
        clock.now += wait
        limiter.take("u")  # waiting Retry-After seconds is always enough

    def test_idle_buckets_are_evicted(self):
        clock = Clock()
        limiter = RateLimiter(per_minute=60, burst=2, clock=clock, max_keys=3)
        for key in "abc":
            limiter.take(key)
        clock.now += 10
        limiter.take("d")
        self.assertLessEqual(len(limiter._buckets), 3)
        self.assertIn("d", limiter._buckets)


class ConcurrencyLimits(unittest.TestCase):
    def test_per_user_and_global_slots(self):
        limiter = ConcurrencyLimiter(per_user=2, total=3)
        with limiter.slot("a"), limiter.slot("a"):
            with self.assertRaises(FormDevError) as caught:
                with limiter.slot("a"):
                    pass
            self.assertEqual((caught.exception.code, caught.exception.status), ("too_many_concurrent_queries", 429))
            with limiter.slot("b"):
                self.assertEqual(limiter.active(), 3)
                with self.assertRaises(FormDevError):
                    with limiter.slot("c"):
                        pass
        self.assertEqual(limiter.active(), 0)

    def test_slots_are_released_when_the_query_fails(self):
        limiter = ConcurrencyLimiter(per_user=1, total=1)
        with self.assertRaises(RuntimeError):
            with limiter.slot("a"):
                raise RuntimeError("query failed")
        self.assertEqual((limiter.active(), limiter._active), (0, {}))
        with limiter.slot("a"):
            pass


class RequestOrder(unittest.TestCase):
    """query_context: rate token, then concurrency slot, then pooled connection."""

    def setUp(self):
        from app.routes import formdev_query as routes
        from app.routes import formdev_runtime as rt

        self.routes, self.rt = routes, rt
        self.runtime = QueryRuntime(policy=policy({"rate": {"per_minute": 60, "burst": 2}, "concurrency": {"per_user": 1, "global": 1}}), cursor_secret=b"t")
        self.checkouts = 0
        saved = (routes.read_token, rt.runtime, rt.checkout, rt.principal_for, rt.storage)
        self.original_checkout = rt.checkout

        @contextmanager
        def checkout(source=None):
            self.checkouts += 1
            yield object()

        @contextmanager
        def storage(connection):
            yield object()

        routes.read_token = lambda request: {"sub": 5}
        rt.runtime = lambda: self.runtime
        rt.checkout = checkout
        rt.principal_for = lambda request, connection: object()
        rt.storage = storage
        self.addCleanup(self.restore, saved)

    def restore(self, saved):
        self.routes.read_token, self.rt.runtime, self.rt.checkout, self.rt.principal_for, self.rt.storage = saved

    def enter(self):
        dependency = self.routes.query_context(object())
        return dependency, next(dependency)

    def test_a_refused_slot_never_takes_a_connection(self):
        with self.runtime.concurrency.slot("5"):
            with self.assertRaises(FormDevError) as caught:
                self.enter()
        self.assertEqual(caught.exception.code, "too_many_concurrent_queries")
        self.assertEqual(self.checkouts, 0)

    def test_a_rate_limited_request_takes_no_slot_and_no_connection(self):
        for _ in range(2):
            dependency, _ = self.enter()
            dependency.close()  # request finished: slot and connection released
        self.assertEqual((self.checkouts, self.runtime.concurrency.active()), (2, 0))
        with self.assertRaises(FormDevError) as caught:
            self.enter()
        self.assertEqual(caught.exception.code, "rate_limited")
        self.assertEqual((self.checkouts, self.runtime.concurrency.active()), (2, 0))

    def test_a_busy_pool_answers_503_quickly(self):
        from psycopg_pool import PoolTimeout

        class Busy:
            def __init__(self):
                self.timeout = None

            @contextmanager
            def connection(self, timeout=None):
                self.timeout = timeout
                raise PoolTimeout("no connection")
                yield  # pragma: no cover

        pool = Busy()
        with self.assertRaises(FormDevError) as caught:
            with self.original_checkout(pool):
                pass
        self.assertEqual((caught.exception.code, caught.exception.status), ("database_busy", 503))
        self.assertEqual(pool.timeout, self.rt.POOL_TIMEOUT_S, "a bounded wait, never the pool default")


# Advisor ----------------------------------------------------------------------------------------------
def catalog(**fields):
    return SourceCatalog(source_id="ward_check", form_id="ward_check", title="Ward", schema_version=1, fields=fields)


def stat(fingerprint, shape, runs=1, timeouts=0, total_ms=10, max_ms=10):
    return {"fingerprint": fingerprint, "source_id": "ward_check", "shape": shape, "runs": runs, "ok": runs - timeouts, "timeouts": timeouts,
            "rejected": 0, "total_ms": total_ms, "max_ms": max_ms, "rows_returned": 0, "first_run_at": 0, "last_run_at": 0}


class Advisor(unittest.TestCase):
    def test_usage_counts_filters_sorts_groups_aggregates_and_refusals(self):
        stats = [
            stat("a", {"filter": {"and": [{"f": "ward", "op": "eq"}, {"not": {"f": "age", "op": "gt"}}]}, "sort": [{"f": "seen_at", "d": "desc"}]}, runs=4),
            stat("b", {"group": ["ward"], "aggregate": [{"fn": "avg", "f": "score"}, {"fn": "count", "f": None}]}, runs=2),
            stat("c", {"rejected_not_indexed": ["full_name"]}, runs=3),
        ]
        self.assertEqual(usage(stats), {
            "ward": {"runs": 6, "rejections": 0}, "age": {"runs": 4, "rejections": 0}, "seen_at": {"runs": 4, "rejections": 0},
            "score": {"runs": 2, "rejections": 0}, "full_name": {"runs": 0, "rejections": 3},
        })

    def test_recommendations(self):
        fields = {
            "full_name": {"type": "text", "indexed": False},
            "ward": {"type": "select", "indexed": True, "origin": "definition"},
            "legacy_code": {"type": "text", "indexed": True, "origin": "config"},
        }
        stats = [stat("hot", {"filter": {"f": "ward", "op": "eq"}}, runs=60), stat("refused", {"rejected_not_indexed": ["full_name"]}, runs=3),
                 stat("slow", {"filter": {"f": "ward", "op": "eq"}}, runs=2, total_ms=5000, max_ms=3000)]
        advice = advise(catalog(**fields), stats, LARGE_FORM_RECORDS, "postgresql")
        kinds = {(item["kind"], item.get("field") or item.get("fingerprint")) for item in advice}
        self.assertEqual(kinds, {("index_field", "full_name"), ("unused_index", "legacy_code"), ("partial_index", "ward"), ("slow_query", "slow")})
        by_kind = {item["kind"]: item for item in advice}
        self.assertEqual(by_kind["index_field"]["action"], {"method": "POST", "path": "/api/formdev/index-config/ward_check/full_name"})
        self.assertEqual(by_kind["unused_index"]["action"]["method"], "DELETE", "a config index can be removed through the API")
        self.assertIn("CREATE INDEX CONCURRENTLY", by_kind["partial_index"]["action"]["sql"])
        self.assertEqual(by_kind["slow_query"]["evidence"]["avg_ms"], 2500)
        self.assertGreater(by_kind["index_field"]["tradeoff"]["storage_bytes"], 0)

    def test_thresholds(self):
        fields = {"full_name": {"type": "text", "indexed": False}, "ward": {"type": "select", "indexed": True, "origin": "definition"}}
        few = [stat("refused", {"rejected_not_indexed": ["full_name"]}, runs=2), stat("hot", {"filter": {"f": "ward", "op": "eq"}}, runs=10)]
        self.assertEqual(advise(catalog(**fields), few, 10, "postgresql"), [], "too few refusals, too few runs, small form")
        self.assertEqual([item["kind"] for item in advise(catalog(**fields), few, LARGE_FORM_RECORDS, "sqlite")], [], "partial indexes are PostgreSQL DDL")
        unused = advise(catalog(**fields, other={"type": "text", "indexed": True, "origin": "definition"}), [stat("hot", {"filter": {"f": "ward", "op": "eq"}}, runs=50)], 10, "sqlite")
        self.assertEqual([(item["kind"], item["field"], item["action"]) for item in unused],
                         [("unused_index", "other", {"note": "remove indexed: true in the next schema version"})])

    def test_partial_index_ddl_refuses_unsafe_identifiers(self):
        self.assertIn("WHERE form_id = 'ward_check' AND field_id = 'ward'", partial_index_ddl("ward_check", "ward", "value_text"))
        for args in (("ward'; DROP TABLE x; --", "ward", "value_text"), ("ward_check", "Ward", "value_text"), ("ward_check", "ward", "data")):
            with self.assertRaises(ValueError):
                partial_index_ddl(*args)


class Statistics(unittest.TestCase):
    def test_collect_drain_and_cap(self):
        collector = StatsCollector(lambda: 5, max_shapes=2)
        collector.record("a", "s", {"x": 1}, "ok", 10, 3)
        collector.record("a", "s", {"x": 1}, "timeouts", 30, 0)
        collector.record("b", "s", {}, "unknown", 1, 0)
        collector.record("c", "s", {}, "ok", 1, 0)  # over the cap: dropped, counted
        rows, dropped = collector.drain()
        self.assertEqual(dropped, 1)
        first = next(row for row in rows if row["fingerprint"] == "a")
        self.assertEqual({key: first[key] for key in ("runs", "ok", "timeouts", "total_ms", "max_ms", "rows_returned")},
                         {"runs": 2, "ok": 1, "timeouts": 1, "total_ms": 40, "max_ms": 30, "rows_returned": 3})
        self.assertEqual(next(row for row in rows if row["fingerprint"] == "b")["rejected"], 1)
        self.assertEqual(collector.drain(), ([], 0))

    def test_a_failing_flush_never_raises(self):
        collector = StatsCollector(lambda: 5)
        collector.record("a", "s", {}, "ok", 1, 1)

        def broken(rows):
            raise RuntimeError("database down")

        self.assertEqual(collector.flush(broken), 0)
        self.assertEqual(collector.flush(broken), 0, "discarded, not retried forever")


if __name__ == "__main__":
    unittest.main()
