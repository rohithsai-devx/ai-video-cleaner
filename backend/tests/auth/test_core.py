"""B-core: db layer and auth, against the compose Postgres as app_api."""

import hashlib
import time
import uuid
from typing import Any
from uuid import UUID

import httpx
import jwt
import pytest
from fastapi import FastAPI, HTTPException

from app.auth import CurrentUser, TenantConn, issue_token
from app.runs import lifecycle
from app.shared import db
from app.shared.config import get_settings

pytestmark = pytest.mark.asyncio(loop_scope="session")

PASSWORD = "correct horse battery"


def _email() -> str:
    return f"u-{uuid.uuid4().hex[:12]}@example.com"


async def _signup(client: httpx.AsyncClient, email: str | None = None) -> tuple[str, str]:
    email = email or _email()
    r = await client.post("/auth/signup", json={"email": email, "password": PASSWORD, "name": "T"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token_type"] == "bearer" and body["expires_in"] == get_settings().jwt_ttl_seconds
    return email, body["access_token"]


def _uid(token: str) -> UUID:
    return UUID(jwt.decode(token, options={"verify_signature": False})["sub"])


async def _create_video(user_id: UUID) -> tuple[UUID, UUID]:
    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "insert into videos (workspace_id, owner_id)"
            " select workspace_id, %s from workspace_members where user_id = %s limit 1"
            " returning id, workspace_id",
            (user_id, user_id),
        )
        row = await cur.fetchone()
        assert row is not None
        return row["id"], row["workspace_id"]


def _probe_app() -> FastAPI:
    """A test-only route that reads one video through the real auth dependency."""
    app = FastAPI()

    @app.get("/probe/videos/{video_id}")
    async def probe(video_id: UUID, conn: TenantConn) -> dict[str, Any]:
        cur = await conn.execute("select id from videos where id = %s", (video_id,))
        if await cur.fetchone() is None:
            raise HTTPException(404, "not found")
        return {"id": str(video_id)}

    @app.get("/probe/me")
    async def me(user_id: CurrentUser) -> dict[str, str]:
        return {"user_id": str(user_id)}

    return app


@pytest.fixture
async def probe() -> Any:
    transport = httpx.ASGITransport(app=_probe_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://probe") as c:
        yield c


async def test_pool_connects_as_app_api_without_bypass() -> None:
    async with db.anon_tx() as conn:
        cur = await conn.execute(
            "select current_user as u, r.rolsuper, r.rolbypassrls"
            " from pg_roles r where r.rolname = current_user"
        )
        row = await cur.fetchone()
    assert row == {"u": "app_api", "rolsuper": False, "rolbypassrls": False}


async def test_signup_then_signin(client: httpx.AsyncClient) -> None:
    email, token = await _signup(client)
    r = await client.post("/auth/signin", json={"email": email.upper(), "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert _uid(r.json()["access_token"]) == _uid(token)
    async with db.tenant_tx(_uid(token)) as conn:
        cur = await conn.execute("select role from workspace_members where user_id = %s", (_uid(token),))
        assert await cur.fetchall() == [{"role": "owner"}]


async def test_duplicate_signup_is_409(client: httpx.AsyncClient) -> None:
    email, _ = await _signup(client)
    r = await client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert r.status_code == 409


async def test_wrong_password_is_401(client: httpx.AsyncClient) -> None:
    email, _ = await _signup(client)
    r = await client.post("/auth/signin", json={"email": email, "password": "not the password"})
    assert r.status_code == 401
    assert "hash" not in r.text and "argon2" not in r.text
    r = await client.post("/auth/signin", json={"email": _email(), "password": PASSWORD})
    assert r.status_code == 401


async def test_bad_or_expired_token_is_401(client: httpx.AsyncClient, probe: httpx.AsyncClient) -> None:
    _, token = await _signup(client)
    assert (await probe.get("/probe/me", headers={"Authorization": f"Bearer {token}"})).status_code == 200

    expired = issue_token(_uid(token), ttl_seconds=-60).access_token
    forged = jwt.encode(
        {"sub": str(_uid(token)), "exp": int(time.time()) + 600},
        "wrong-secret-" + "x" * 32,
        algorithm="HS256",
    )
    no_sub = jwt.encode(
        {"exp": int(time.time()) + 600}, get_settings().jwt_secret.get_secret_value(), algorithm="HS256"
    )
    for headers in (
        {},
        {"Authorization": f"Bearer {expired}"},
        {"Authorization": f"Bearer {forged}"},
        {"Authorization": f"Bearer {no_sub}"},
        {"Authorization": "Bearer garbage"},
    ):
        r = await probe.get(f"/probe/videos/{uuid.uuid4()}", headers=headers)
        assert r.status_code == 401, headers


async def test_user_a_cannot_read_user_b_rows(client: httpx.AsyncClient, probe: httpx.AsyncClient) -> None:
    _, token_a = await _signup(client)
    _, token_b = await _signup(client)
    video_b, _ = await _create_video(_uid(token_b))

    r = await probe.get(f"/probe/videos/{video_b}", headers={"Authorization": f"Bearer {token_b}"})
    assert r.status_code == 200
    r = await probe.get(f"/probe/videos/{video_b}", headers={"Authorization": f"Bearer {token_a}"})
    assert r.status_code == 404


async def test_tenant_identity_does_not_leak_to_next_transaction(client: httpx.AsyncClient) -> None:
    _, token = await _signup(client)
    uid = _uid(token)
    await _create_video(uid)
    async with db.tenant_tx(uid) as conn:
        cur = await conn.execute("select pg_backend_pid() as pid, app.uid() as uid")
        first = await cur.fetchone()
    assert first is not None and first["uid"] == uid

    async with db.anon_tx() as conn:
        cur = await conn.execute(
            "select pg_backend_pid() as pid, app.uid() as uid, (select count(*) from videos) as n"
        )
        second = await cur.fetchone()
    assert second == {"pid": first["pid"], "uid": None, "n": 0}


async def test_cas_loser_gets_zero_rows(client: httpx.AsyncClient) -> None:
    _, token = await _signup(client)
    uid = _uid(token)
    video_id, ws = await _create_video(uid)
    async with db.tenant_tx(uid) as conn:
        cur = await conn.execute(
            "insert into runs (workspace_id, video_id, created_by, mode, voice)"
            " values (%s, %s, %s, 'review', 'original') returning id",
            (ws, video_id, uid),
        )
        row = await cur.fetchone()
        assert row is not None
        run_id = row["id"]

    # stage moves belong to app_worker (app_api cannot set started_at), so the CAS runs as the worker
    worker_url = get_settings().database_url_worker
    assert worker_url
    w = await db.connect_as(worker_url, db.WORKER_ROLE)
    try:
        async with w.transaction():
            await w.execute("select set_config('app.workspace_id', %s, true)", (str(ws),))
            queued = await lifecycle.load(w, run_id)
            assert queued is not None
            await lifecycle.advance(w, queued, "preprocessing", stage="x")
        async with w.transaction():
            await w.execute("select set_config('app.workspace_id', %s, true)", (str(ws),))
            with pytest.raises(lifecycle.Lost):  # the stale queued ref loses its compare-and-set
                await lifecycle.advance(w, queued, "preprocessing")
            cur = await w.execute("select status, stage from runs where id = %s", (run_id,))
            assert await cur.fetchone() == {"status": "preprocessing", "stage": "x"}
    finally:
        await w.close()

    # outbox: deterministic task id, written in the caller's transaction, idempotent on replay
    expected_id = hashlib.sha256(f"{run_id}:preprocess:1".encode()).hexdigest()
    assert db.task_id(run_id, "preprocess", 1) == expected_id
    for _ in range(2):
        async with db.tenant_tx(uid) as conn:
            got = await db.enqueue(
                conn,
                workspace_id=ws,
                run_id=run_id,
                queue="pre-cpu",
                stage="preprocess",
                attempt=1,
                payload={"run_id": str(run_id)},
            )
            assert got == expected_id
