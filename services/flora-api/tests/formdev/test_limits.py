"""Rate and concurrency limits (Phase 4.11).

Unit tests drive RateLimiter and ConcurrencyLimiter with an injected clock. The route tests drive the
real ASGI app (no network, no httpx) with a counting fake pool, to show the documented order:
session token -> rate limit -> concurrency slot -> pooled connection. A refused request must never
check out a connection, and a slot must be released however the request ends.
"""
import asyncio
import json
import os
import threading
import unittest
from contextlib import ExitStack, contextmanager, nullcontext
from unittest import mock

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

from psycopg_pool import PoolTimeout  # noqa: E402

from app.formdev.adapters.sqlite import SQLiteAdapter  # noqa: E402
from app.formdev.errors import FormDevError  # noqa: E402
from app.formdev.query.engine import QueryEngine, QueryRuntime  # noqa: E402
from app.formdev.query.limits import ConcurrencyLimiter, RateLimiter  # noqa: E402
from helpers import USER, ready_services  # noqa: E402
from test_query_engine import ADMIN, WARD_FORM, ward_record  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class RateLimiterTests(unittest.TestCase):
    def refused(self, limiter, key="u1", cost=1.0):
        with self.assertRaises(FormDevError) as caught:
            limiter.take(key, cost)
        self.assertEqual((caught.exception.code, caught.exception.status), ("rate_limited", 429))
        return caught.exception.details["retry_after"]

    def test_burst_is_allowed_then_refused(self):
        limiter = RateLimiter(60, 3, clock=Clock())
        for _ in range(3):
            limiter.take("u1")
        self.assertEqual(self.refused(limiter), 1)

    def test_tokens_refill_at_the_per_minute_rate_up_to_the_burst(self):
        clock = Clock()
        limiter = RateLimiter(60, 2, clock=clock)
        limiter.take("u1")
        limiter.take("u1")
        clock.now += 0.5
        self.refused(limiter)
        clock.now += 0.5
        limiter.take("u1")  # one token per second at 60/min
        self.refused(limiter)
        clock.now += 3600
        limiter.take("u1")
        limiter.take("u1")
        self.refused(limiter)  # an hour idle still only refills to the burst

    def test_waiting_retry_after_seconds_is_enough(self):
        # Retry-After is a promise: a client that waits exactly that long must be served.
        for per_minute in (1, 7, 30, 45, 50, 60, 90, 120, 1000):
            with self.subTest(per_minute=per_minute):
                clock = Clock()
                limiter = RateLimiter(per_minute, 1, clock=clock)
                limiter.take("u1")
                retry_after = self.refused(limiter)
                self.assertIsInstance(retry_after, int)
                self.assertGreaterEqual(retry_after, 1)
                clock.now += retry_after
                limiter.take("u1")

    def test_a_refused_request_does_not_spend_tokens(self):
        clock = Clock()
        limiter = RateLimiter(60, 1, clock=clock)
        limiter.take("u1")
        for _ in range(5):
            self.refused(limiter)
        clock.now += 1
        limiter.take("u1")

    def test_keys_are_independent(self):
        limiter = RateLimiter(60, 1, clock=Clock())
        limiter.take("u1")
        self.refused(limiter, "u1")
        limiter.take("u2")
        limiter.take("refresh:u1")

    def test_fractional_cost(self):
        limiter = RateLimiter(60, 1, clock=Clock())
        for _ in range(5):
            limiter.take("u1", 0.2)  # catalog/validate calls cost a fifth of a query
        self.refused(limiter, cost=0.2)

    def test_idle_full_buckets_are_evicted_past_max_keys(self):
        clock = Clock()
        limiter = RateLimiter(60, 2, clock=clock, max_keys=2)
        limiter.take("idle")
        clock.now += 60
        limiter.take("u1")
        limiter.take("u2")
        self.assertEqual(sorted(limiter._buckets), ["u1", "u2"])
        limiter.take("u1")
        self.refused(limiter, "u1")  # eviction never resets a bucket that is still in use


class ConcurrencyLimiterTests(unittest.TestCase):
    def refused(self, limiter, key):
        with self.assertRaises(FormDevError) as caught:
            with limiter.slot(key):
                self.fail("slot granted")
        self.assertEqual((caught.exception.code, caught.exception.status), ("too_many_concurrent_queries", 429))
        self.assertEqual(caught.exception.details, {"retry_after": 1})

    def test_per_user_limit(self):
        limiter = ConcurrencyLimiter(per_user=2, total=4)
        with ExitStack() as held:
            held.enter_context(limiter.slot("u1"))
            held.enter_context(limiter.slot("u1"))
            self.refused(limiter, "u1")
            with limiter.slot("u2"):
                self.assertEqual(limiter.active(), 3)
            self.assertEqual(limiter.active(), 2)
        self.assertEqual(limiter.active(), 0)
        with limiter.slot("u1"):
            pass

    def test_global_limit(self):
        limiter = ConcurrencyLimiter(per_user=2, total=3)
        with ExitStack() as held:
            for key in ("u1", "u2", "u3"):
                held.enter_context(limiter.slot(key))
            self.refused(limiter, "u4")
            self.refused(limiter, "u1")
            self.assertEqual(limiter.active(), 3, "a refusal takes nothing")
        self.assertEqual(limiter.active(), 0)

    def test_slot_is_released_when_the_work_raises(self):
        limiter = ConcurrencyLimiter(per_user=1, total=1)
        for error in (RuntimeError("boom"), FormDevError("query_timeout", "late", 504)):
            with self.subTest(error=error):
                with self.assertRaises(type(error)):
                    with limiter.slot("u1"):
                        raise error
                self.assertEqual(limiter.active(), 0)
                self.assertEqual(limiter._active, {})
        with limiter.slot("u1"):
            self.assertEqual(limiter.active(), 1)

    def test_threads_never_exceed_the_global_limit(self):
        limiter = ConcurrencyLimiter(per_user=8, total=3)
        start, release = threading.Barrier(12), threading.Event()
        granted, refused, peak, lock = [], [], [0], threading.Lock()

        def worker(n):
            start.wait()
            try:
                with limiter.slot(f"u{n % 4}"):
                    with lock:
                        granted.append(n)
                        peak[0] = max(peak[0], limiter.active())
                    release.wait(5)
            except FormDevError:
                refused.append(n)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(12)]
        for thread in threads:
            thread.start()
        while len(granted) + len(refused) < 12:
            release.wait(0.01)
        release.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual((len(granted), len(refused), peak[0]), (3, 9, 3))
        self.assertEqual(limiter.active(), 0)


class FakePool:
    """Counts checkouts; ``busy`` behaves like an exhausted pool (psycopg_pool raises PoolTimeout)."""

    def __init__(self):
        self.checkouts = 0
        self.busy = False

    @contextmanager
    def connection(self, timeout):
        if self.busy:
            raise PoolTimeout(f"no connection within {timeout} s")
        self.checkouts += 1
        yield object()


class RouteOrder(unittest.TestCase):
    """The query dependency through the real app: token -> rate -> slot -> pool -> permissions."""

    def setUp(self):
        from app.main import app
        from app.routes import formdev_query, formdev_runtime as rt

        self.app = app
        self.adapter = SQLiteAdapter(":memory:")
        self.fd = ready_services(self.adapter)
        self.fd.schemas.create_form(WARD_FORM, USER)
        self.fd.schemas.publish("ward_check", 1, USER)
        for n in range(5):
            self.fd.records.create("ward_check", ward_record(n), USER)
        self.clock = Clock()
        self.pool = FakePool()
        self.runtime = self.make_runtime(per_minute=60, burst=20, per_user=1, total=2)
        self.patches = ExitStack()
        self.patches.enter_context(mock.patch.object(rt, "_runtime", self.runtime))
        self.patches.enter_context(mock.patch.object(rt, "pool", self.pool))
        self.patches.enter_context(mock.patch.object(rt, "storage", lambda connection: nullcontext(self.fd)))
        self.patches.enter_context(mock.patch.object(rt, "principal_for", self.principal_for))
        self.patches.enter_context(mock.patch.object(formdev_query, "read_token", lambda request: {"sub": request.headers.get("x-test-user", "1")}))
        # No account registry here: the account middleware (app/account_middleware.py) would wait on a database.
        from app import account_middleware
        self.patches.enter_context(mock.patch.object(account_middleware, "resolve", lambda path, headers: None))

    def tearDown(self):
        self.patches.close()
        self.adapter.close()

    def make_runtime(self, per_minute, burst, per_user, total):
        return QueryRuntime(cursor_secret=b"limits", rate=RateLimiter(per_minute, burst, clock=self.clock),
                            concurrency=ConcurrencyLimiter(per_user, total))

    def principal_for(self, request, connection):
        self.assertIsNotNone(connection, "permissions are loaded on the checked-out connection")
        return ADMIN

    def request(self, method, path, body=None, user="1"):
        raw = json.dumps(body).encode() if body is not None else b""
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
                 "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "", "client": ("127.0.0.1", 1),
                 "server": ("test", 80), "headers": [(b"host", b"test"), (b"content-type", b"application/json"),
                                                     (b"content-length", str(len(raw)).encode()), (b"x-test-user", user.encode())]}
        incoming = [{"type": "http.request", "body": raw, "more_body": False}]
        sent = []

        async def receive():
            if incoming:
                return incoming.pop(0)
            await asyncio.Event().wait()  # no disconnect while the response is produced

        async def send(message):
            sent.append(message)

        asyncio.run(self.app(scope, receive, send))
        start = next(message for message in sent if message["type"] == "http.response.start")
        headers = {key.decode().lower(): value.decode() for key, value in start["headers"]}
        content = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
        return start["status"], headers, json.loads(content or b"null")

    def query(self, user="1", **query):
        query.setdefault("source", "ward_check")
        query.setdefault("select", ["hn"])
        query.setdefault("pagination", {"mode": "cursor", "limit": 10})
        return self.request("POST", "/api/formdev/query", {"query": query}, user)

    def test_allowed_query_holds_a_slot_while_running_and_one_connection(self):
        seen = {}
        real_run = QueryEngine.run

        def run(engine, *args):
            seen.update(active=self.runtime.concurrency.active(), checkouts=self.pool.checkouts)
            return real_run(engine, *args)

        with mock.patch.object(QueryEngine, "run", run):
            status, _, body = self.query()
        self.assertEqual(status, 200, body)
        self.assertEqual(len(body["rows"]), 5)
        self.assertEqual(seen, {"active": 1, "checkouts": 1})
        self.assertEqual((self.pool.checkouts, self.runtime.concurrency.active()), (1, 0))

    def test_rate_limited_request_never_takes_a_connection(self):
        self.runtime.rate = RateLimiter(60, 1, clock=self.clock)
        self.assertEqual(self.query()[0], 200)
        status, headers, body = self.query()
        self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(headers["retry-after"], "1")
        self.assertEqual(self.pool.checkouts, 1, "the refused request did not touch the pool")
        self.assertEqual(self.runtime.concurrency.active(), 0)
        self.clock.now += 1
        self.assertEqual(self.query()[0], 200)
        self.assertEqual(self.query(user="2")[0], 200, "another user has their own bucket")

    def test_rate_is_checked_before_the_slot(self):
        self.runtime.rate = RateLimiter(60, 0, clock=self.clock)
        with self.runtime.concurrency.slot("1"):
            status, _, body = self.query()
            self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(self.pool.checkouts, 0)

    def test_saturated_slots_refuse_without_a_connection(self):
        with self.runtime.concurrency.slot("1"):  # the same user's earlier query is still running
            status, headers, body = self.query()
            self.assertEqual((status, body["code"], headers["retry-after"]), (429, "too_many_concurrent_queries", "1"))
            self.assertEqual(self.query(user="2")[0], 200, "per-user limit only")
            with self.runtime.concurrency.slot("3"):  # global limit (2) reached by other users
                status, _, body = self.query(user="2")
                self.assertEqual((status, body["code"]), (429, "too_many_concurrent_queries"))
        self.assertEqual(self.pool.checkouts, 1, "only the admitted request took a connection")
        self.assertEqual(self.query()[0], 200)

    def test_saved_query_run_uses_the_same_limits(self):
        with self.runtime.concurrency.slot("1"):
            status, _, body = self.request("POST", "/api/formdev/queries/q-1/run", {})
        self.assertEqual((status, body["code"]), (429, "too_many_concurrent_queries"))
        self.assertEqual(self.pool.checkouts, 0)

    def test_catalog_calls_need_no_slot_but_pay_a_fraction_of_the_rate(self):
        self.runtime.rate = RateLimiter(60, 1, clock=self.clock)
        with self.runtime.concurrency.slot("1"), self.runtime.concurrency.slot("2"):
            for _ in range(5):
                status, _, body = self.request("GET", "/api/formdev/query/sources")
                self.assertEqual(status, 200, body)
            status, _, body = self.request("GET", "/api/formdev/query/sources")
        self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(self.pool.checkouts, 5)

    def test_pool_timeout_is_database_busy_and_releases_the_slot(self):
        self.pool.busy = True
        status, headers, body = self.query()
        self.assertEqual((status, body["code"], headers["retry-after"]), (503, "database_busy", "2"))
        self.assertEqual(self.runtime.concurrency.active(), 0)
        self.pool.busy = False
        self.assertEqual(self.query()[0], 200)

    def test_slot_is_released_when_the_query_fails(self):
        status, _, body = self.query(select=["no_such_field"])
        self.assertEqual((status, body["code"]), (422, "invalid_query"))
        self.assertEqual(self.runtime.concurrency.active(), 0)
        with mock.patch.object(QueryEngine, "run", side_effect=RuntimeError("driver crashed")):
            with self.assertRaises(RuntimeError):
                self.query()
        self.assertEqual(self.runtime.concurrency.active(), 0)
        self.assertEqual(self.query()[0], 200, "per_user=1: the slot really came back")


if __name__ == "__main__":
    unittest.main()
