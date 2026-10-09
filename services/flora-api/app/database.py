import os
from collections.abc import Iterator

from fastapi import Request
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


DATABASE_URL = os.environ["FLORA_DATABASE_URL"]

pool = ConnectionPool(
    conninfo=DATABASE_URL,
    min_size=1,
    max_size=10,
    kwargs={"autocommit": True, "row_factory": dict_row},
    open=False,
)


# Small dedicated pool for FormDev background jobs and statistics flushes, so long-running jobs
# never take connections from interactive requests. Opened on demand by the job runtime.
job_pool = ConnectionPool(
    conninfo=DATABASE_URL,
    min_size=0,
    max_size=int(os.getenv("FORMDEV_JOB_POOL_SIZE", "2")),
    kwargs={"autocommit": True, "row_factory": dict_row},
    check=ConnectionPool.check_connection,
    open=False,
)


def open_pool() -> None:
    pool.open(wait=True, timeout=10)


def close_pool() -> None:
    pool.close()
    if not job_pool.closed:
        job_pool.close()


CHANGE_SET_HEADER = "x-flora-change-set"


def connection(request: Request) -> Iterator[Connection]:
    """A request's connection. Chart writes carry X-Flora-Change-Set: the database logs
    them under that id (0078-case-change-log.sql) so the chart can undo them."""
    change_set = request.headers.get(CHANGE_SET_HEADER, "").strip()[:64] if request.method != "GET" else ""
    with pool.connection() as database:
        if change_set:
            database.execute("SELECT set_config('flora.change_set', %s, false)", (change_set,))
        try:
            yield database
        finally:
            if change_set:
                # Pooled connections are shared; never leak the id (or actor) to the next user.
                try:
                    database.execute("SELECT set_config('flora.change_set', '', false), set_config('flora.actor', '', false)")
                except Exception:
                    pass
