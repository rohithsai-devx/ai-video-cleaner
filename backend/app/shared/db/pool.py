"""The app_api and app_worker connection pools and the transaction scopes every request and stage runs in.

Identity reaches Postgres only through ``set_config(...)`` inside one transaction, so it ends with that
transaction (commit or rollback). Session-level SET is banned. The API binds ``app.user_id``; workers bind
``app.workspace_id``.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

Conn = AsyncConnection[DictRow]

API_ROLE = "app_api"
WORKER_ROLE = "app_worker"
RELAY_ROLE = "app_relay"

_api_pool: AsyncConnectionPool[Conn] | None = None
_worker_pool: AsyncConnectionPool[Conn] | None = None


async def _check_role(conn: Conn, *, role: str) -> None:
    """Refuse to hand out a connection that is not the expected role or that could bypass RLS."""
    cur = await conn.execute(
        "select current_user as u, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
    )
    row = await cur.fetchone()
    if row is None or row["u"] != role or row["rolsuper"] or row["rolbypassrls"]:
        raise RuntimeError(f"pool must connect as {role} without SUPERUSER/BYPASSRLS, got {row}")


async def connect_as(conninfo: str, role: str) -> Conn:
    """A single role-checked connection (the relay's, which is not pooled)."""
    conn: Conn = await AsyncConnection[DictRow].connect(conninfo, autocommit=True, row_factory=dict_row)
    try:
        await _check_role(conn, role=role)
    except Exception:
        await conn.close()
        raise
    return conn


async def _open(conninfo: str, role: str, min_size: int, max_size: int) -> AsyncConnectionPool[Conn]:
    pool: AsyncConnectionPool[Conn] = AsyncConnectionPool(
        conninfo,
        min_size=min_size,
        max_size=max_size,
        kwargs={"row_factory": dict_row, "autocommit": True},
        configure=partial(_check_role, role=role),
        open=False,
    )
    await pool.open(wait=True)
    return pool


async def open_pool(conninfo: str, *, min_size: int = 1, max_size: int = 10) -> None:
    global _api_pool
    if _api_pool is not None:
        return
    _api_pool = await _open(conninfo, API_ROLE, min_size, max_size)


async def close_pool() -> None:
    global _api_pool
    if _api_pool is not None:
        await _api_pool.close()
        _api_pool = None


async def open_worker_pool(conninfo: str, *, min_size: int = 1, max_size: int = 4) -> None:
    global _worker_pool
    if _worker_pool is not None:
        return
    _worker_pool = await _open(conninfo, WORKER_ROLE, min_size, max_size)


async def close_worker_pool() -> None:
    global _worker_pool
    if _worker_pool is not None:
        await _worker_pool.close()
        _worker_pool = None


def get_pool() -> AsyncConnectionPool[Conn]:
    if _api_pool is None:
        raise RuntimeError("database pool is not open")
    return _api_pool


def get_worker_pool() -> AsyncConnectionPool[Conn]:
    if _worker_pool is None:
        raise RuntimeError("worker database pool is not open")
    return _worker_pool


async def set_user(conn: Conn, user_id: UUID) -> None:
    """Bind the user for the rest of the current transaction only (is_local = true)."""
    await conn.execute("select set_config('app.user_id', %s, true)", (str(user_id),))


@asynccontextmanager
async def anon_tx() -> AsyncIterator[Conn]:
    """One transaction with no identity: every RLS policy is false. For sign-in/sign-up only."""
    async with get_pool().connection() as conn, conn.transaction():
        yield conn


@asynccontextmanager
async def tenant_tx(user_id: UUID) -> AsyncIterator[Conn]:
    """One transaction acting as ``user_id``; RLS scopes every row to that user's workspaces."""
    async with get_pool().connection() as conn, conn.transaction():
        await set_user(conn, user_id)
        yield conn


@asynccontextmanager
async def worker_tx(workspace_id: UUID | str) -> AsyncIterator[Conn]:
    """One app_worker transaction acting for ``workspace_id`` (a pipeline stage)."""
    async with get_worker_pool().connection() as conn, conn.transaction():
        await conn.execute("select set_config('app.workspace_id', %s, true)", (str(workspace_id),))
        yield conn


__all__ = [
    "API_ROLE",
    "Conn",
    "RELAY_ROLE",
    "WORKER_ROLE",
    "anon_tx",
    "close_pool",
    "close_worker_pool",
    "connect_as",
    "get_pool",
    "get_worker_pool",
    "open_pool",
    "open_worker_pool",
    "set_user",
    "tenant_tx",
    "worker_tx",
]
