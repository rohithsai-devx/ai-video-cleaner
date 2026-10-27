"""Pipeline stages and the in-process relay, against real Postgres, Redis and fake-gcs.

Engines are FixtureEngines. Raw objects are seeded with ``storage.put``; outputs are checked with
``storage.exists``.
"""

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import httpx
import jwt
import pytest
import redis.asyncio as aioredis
from fastapi import FastAPI
from google.api_core.exceptions import Conflict

from app.auth.router import router as auth_router
from app.contracts.events import RunFailedEvent
from app.pipeline import relay, stages
from app.pipeline.fixture_engines import FixtureEngines
from app.pipeline.relay import Task
from app.runs import lifecycle
from app.shared import db
from app.shared.config import get_settings
from app.shared.storage import GcsStorage, get_storage

pytestmark = pytest.mark.asyncio(loop_scope="session")

PASSWORD = "correct horse battery"
TIMEOUT_S = 15


@pytest.fixture
async def api() -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    app.include_router(auth_router)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def storage() -> GcsStorage:
    store = get_storage()
    with contextlib.suppress(Conflict):
        await asyncio.to_thread(store.client.create_bucket, store.bucket_name)  # type: ignore[attr-defined]
    return store


@pytest.fixture
async def worker_pool() -> AsyncIterator[None]:
    url = get_settings().database_url_worker
    assert url, "DATABASE_URL_WORKER must be set for the pipeline tests"
    await db.open_worker_pool(url)
    try:
        yield
    finally:
        await db.close_worker_pool()


@pytest.fixture
async def worker(worker_pool: None, storage: GcsStorage) -> AsyncIterator[None]:
    stop = asyncio.Event()
    task = asyncio.create_task(relay.run_in_process(stop, FixtureEngines(storage), storage))
    try:
        yield
    finally:
        stop.set()
        await asyncio.wait_for(task, TIMEOUT_S)


async def _signup(client: httpx.AsyncClient) -> UUID:
    email = f"p-{uuid.uuid4().hex[:12]}@example.com"
    r = await client.post("/auth/signup", json={"email": email, "password": PASSWORD, "name": "P"})
    assert r.status_code == 201, r.text
    return UUID(jwt.decode(r.json()["access_token"], options={"verify_signature": False})["sub"])


async def _start_run(user_id: UUID, mode: str, storage: GcsStorage) -> tuple[UUID, UUID, UUID]:
    """Seed an uploaded video, then start its run through lifecycle.start (the only run writer).

    Returns (run_id, video_id, workspace_id).
    """
    video_id = uuid.uuid4()
    uri = storage.raw_uri(video_id)
    await storage.put(uri, b"fake video bytes", "video/webm")
    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "insert into videos (id, workspace_id, owner_id, raw_uri, status)"
            " select %s, workspace_id, %s, %s, 'uploaded' from workspace_members where user_id = %s limit 1"
            " returning id, workspace_id",
            (video_id, user_id, uri, user_id),
        )
        v = await cur.fetchone()
        assert v is not None
        run, _ = await lifecycle.start(conn, video_id=video_id, mode=mode, voice="original", voice_id=None)  # type: ignore[arg-type]
    return run.id, v["id"], v["workspace_id"]


async def _status(user_id: UUID, run_id: UUID) -> dict[str, Any]:
    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "select r.status, r.finished_at, r.started_at, v.status as video_status, v.output_uri"
            " from runs r join videos v on v.id = r.video_id where r.id = %s",
            (run_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        return row


async def _wait_status(user_id: UUID, run_id: UUID, want: str, limit_s: float = TIMEOUT_S) -> dict[str, Any]:
    async with asyncio.timeout(limit_s):
        while True:
            row = await _status(user_id, run_id)
            if row["status"] == want:
                return row
            await asyncio.sleep(0.05)


async def _proposals(user_id: UUID, run_id: UUID) -> list[tuple[int, str]]:
    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "select version, source from proposals where run_id = %s order by version", (run_id,)
        )
        return [(p["version"], p["source"]) for p in await cur.fetchall()]


async def _collect_until_done(pubsub: Any) -> list[tuple[str, dict[str, Any]]]:
    seen: list[tuple[str, dict[str, Any]]] = []
    async with asyncio.timeout(TIMEOUT_S):
        while not seen or seen[-1][0] != "run.done":
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1)
            if msg:
                body = json.loads(msg["data"])
                seen.append((body["event"], body["data"]))
    return seen


async def test_auto_run_reaches_done_with_output_object(
    api: httpx.AsyncClient, storage: GcsStorage, worker: None
) -> None:
    uid = await _signup(api)
    r = aioredis.Redis.from_url(get_settings().redis_url)
    pubsub = r.pubsub()
    run_id, video_id, _ = await _start_run(uid, "auto", storage)
    await pubsub.subscribe(f"run:{run_id}")
    try:
        seen = await _collect_until_done(pubsub)
    finally:
        await pubsub.aclose()
        await r.aclose()

    names = [name for name, _ in seen]
    assert names.index("run.proposal_ready") < names.index("run.done"), names
    ready = next(d for n, d in seen if n == "run.proposal_ready")
    assert ready["version"] == 1 and ready["auto_approved"] is True
    done = seen[-1][1]
    assert done["video_id"] == str(video_id)
    assert done["output_uri"].startswith("http")

    row = await _status(uid, run_id)
    assert row["status"] == "done" and row["finished_at"] and row["started_at"]
    assert row["video_status"] == "ready"
    expected_output = storage.output_uri(run_id, 1)
    assert row["output_uri"] == expected_output
    assert await storage.exists(expected_output)  # the object exists before the row points to it
    assert await _proposals(uid, run_id) == [(1, "agent")]


async def test_review_run_waits_then_approve_finishes(
    api: httpx.AsyncClient, storage: GcsStorage, worker: None
) -> None:
    uid = await _signup(api)
    run_id, _, _ = await _start_run(uid, "review", storage)

    row = await _wait_status(uid, run_id, "awaiting_review")
    assert row["video_status"] == "awaiting_review"
    assert await _proposals(uid, run_id) == [(1, "agent")]

    await asyncio.sleep(0.3)
    assert (await _status(uid, run_id))["status"] == "awaiting_review"

    # approve (the router's job): one advance, which enqueues post-io in the same transaction
    async with db.tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        await lifecycle.advance(conn, run, "approved", stage="approved")

    row = await _wait_status(uid, run_id, "done")
    assert row["video_status"] == "ready"
    assert await storage.exists(storage.output_uri(run_id, 1))


async def test_cancelled_run_is_left_alone_by_its_stage(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    """A run cancelled before its stage runs: the stage sees a non-matching status and moves nothing.

    (A cancel during a stage waits on the row lock that lifecycle.load takes, so the stage's own
    compare-and-set cannot lose; its Lost branch is defensive.)"""
    uid = await _signup(api)
    run_id, _, ws = await _start_run(uid, "review", storage)
    async with db.tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        await lifecycle.advance(conn, run, "cancelled", stage=None)

    task = Task(task_id=db.task_id(run_id, "pre-cpu", 1), queue="pre-cpu", run_id=run_id, workspace_id=ws)
    assert await stages.handle(task, FixtureEngines(storage), storage) == []
    assert (await _status(uid, run_id))["status"] == "cancelled"
    assert await _proposals(uid, run_id) == []


async def test_duplicate_delivery_is_a_no_op(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    uid = await _signup(api)
    run_id, _, ws = await _start_run(uid, "review", storage)
    engines = FixtureEngines(storage)
    pre = Task(task_id=db.task_id(run_id, "pre-cpu", 1), queue="pre-cpu", run_id=run_id, workspace_id=ws)
    agent = Task(task_id=db.task_id(run_id, "agent", 1), queue="agent", run_id=run_id, workspace_id=ws)

    first = await stages.handle(pre, engines, storage)
    assert [name for name, _ in first][-1] == "run.status"
    assert await stages.handle(pre, engines, storage) == []  # replayed: the run is past queued

    first = await stages.handle(agent, engines, storage)
    assert [name for name, _ in first][0] == "run.proposal_ready"
    assert await stages.handle(agent, engines, storage) == []  # replayed: the run is past agent_running

    assert (await _status(uid, run_id))["status"] == "awaiting_review"
    assert await _proposals(uid, run_id) == [(1, "agent")]
    relay_url = get_settings().database_url_relay
    assert relay_url
    conn = await db.connect_as(relay_url, db.RELAY_ROLE)  # the outbox is readable by the relay role only
    try:
        cur = await conn.execute(
            "select count(*) as n from outbox where run_id = %s and queue = 'agent'", (run_id,)
        )
        assert await cur.fetchone() == {"n": 1}
    finally:
        await conn.close()


class _Broken(FixtureEngines):
    def __init__(self, storage: GcsStorage, where: str) -> None:
        super().__init__(storage)
        self.where = where

    async def propose(self, run: Any, pre: Any) -> Any:
        if self.where == "agent":
            raise RuntimeError("model timed out")
        return await super().propose(run, pre)

    async def render(self, run: Any, proposal: Any, output_uri: str, *, voice: str = "original") -> None:
        del voice
        if self.where == "render":
            raise RuntimeError("ffmpeg exited 1")
        await super().render(run, proposal, output_uri)


class _BoomPreprocess(FixtureEngines):
    """Raises in preprocess after the run has already committed to preprocessing."""

    def __init__(self, storage: GcsStorage, user_id: UUID, run_id: UUID) -> None:
        super().__init__(storage)
        self._user_id = user_id
        self._run_id = run_id
        self.saw: str | None = None

    async def preprocess(self, run: Any, raw_uri: str) -> Any:
        self.saw = (await _status(self._user_id, self._run_id))["status"]
        raise RuntimeError("boom")


class _PreprocessAfterCommit(FixtureEngines):
    """Succeeds only once the committed status is already preprocessing."""

    def __init__(self, storage: GcsStorage, user_id: UUID, run_id: UUID) -> None:
        super().__init__(storage)
        self._user_id = user_id
        self._run_id = run_id

    async def preprocess(self, run: Any, raw_uri: str) -> Any:
        assert (await _status(self._user_id, self._run_id))["status"] == "preprocessing"
        return await super().preprocess(run, raw_uri)


async def test_preprocess_failure_after_status_commit_marks_the_run_failed(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    uid = await _signup(api)
    run_id, _, ws = await _start_run(uid, "review", storage)
    engines = _BoomPreprocess(storage, uid, run_id)
    task = Task(task_id=db.task_id(run_id, "pre-cpu", 1), queue="pre-cpu", run_id=run_id, workspace_id=ws)
    events = await stages.handle(task, engines, storage)
    assert engines.saw == "preprocessing"  # beat 1 committed before ffmpeg
    name, err = events[-1]
    assert name == "run.failed" and isinstance(err, RunFailedEvent)
    assert err.stage == "pre-cpu" and err.retryable is True
    row = await _status(uid, run_id)
    assert row["status"] == "failed" and row["video_status"] == "failed"


async def test_preprocess_sees_committed_status_and_a_replay_is_a_no_op(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    uid = await _signup(api)
    run_id, _, ws = await _start_run(uid, "review", storage)
    engines = _PreprocessAfterCommit(storage, uid, run_id)
    task = Task(task_id=db.task_id(run_id, "pre-cpu", 1), queue="pre-cpu", run_id=run_id, workspace_id=ws)

    first = await stages.handle(task, engines, storage)
    assert [name for name, _ in first][-1] == "run.status"
    assert (await _status(uid, run_id))["status"] == "agent_running"
    async with db.tenant_tx(uid) as conn:
        cur = await conn.execute(
            "select r.pre, v.duration_s from runs r join videos v on v.id = r.video_id where r.id = %s",
            (run_id,),
        )
        written = await cur.fetchone()
    assert written is not None
    assert written["pre"]["duration"] == 60
    assert float(written["duration_s"]) == 60.0

    assert await stages.handle(task, engines, storage) == []
    assert (await _status(uid, run_id))["status"] == "agent_running"


async def test_preprocessing_redelivery_finishes_the_stage(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    """A crash after the status commit leaves the run preprocessing; the next handle finishes it."""
    uid = await _signup(api)
    run_id, _, ws = await _start_run(uid, "review", storage)
    async with db.worker_tx(ws) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None and run.status == "queued"
        await lifecycle.advance(conn, run, "preprocessing", stage="preprocess")

    task = Task(task_id=db.task_id(run_id, "pre-cpu", 1), queue="pre-cpu", run_id=run_id, workspace_id=ws)
    events = await stages.handle(task, FixtureEngines(storage), storage)
    assert [name for name, _ in events][-1] == "run.status"
    assert (await _status(uid, run_id))["status"] == "agent_running"


async def test_relay_sets_sent_at_only_after_handle(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    seen: dict[UUID, Any] = {}

    class _Watch(FixtureEngines):
        async def preprocess(self, run: Any, raw_uri: str) -> Any:
            relay_url = get_settings().database_url_relay
            assert relay_url
            conn = await db.connect_as(relay_url, db.RELAY_ROLE)
            try:
                cur = await conn.execute(
                    "select sent_at from outbox where run_id = %s and queue = 'pre-cpu'", (run.id,)
                )
                row = await cur.fetchone()
            finally:
                await conn.close()
            assert row is not None
            seen[run.id] = row["sent_at"]
            return await super().preprocess(run, raw_uri)

    stop = asyncio.Event()
    worker = asyncio.create_task(relay.run_in_process(stop, _Watch(storage), storage))
    try:
        uid = await _signup(api)
        run_id, _, _ = await _start_run(uid, "auto", storage)
        await _wait_status(uid, run_id, "done")
    finally:
        stop.set()
        await asyncio.wait_for(worker, TIMEOUT_S)

    assert seen[run_id] is None  # claim holds the row, but sent_at waits until handle returns
    relay_url = get_settings().database_url_relay
    assert relay_url
    # done commits inside handle; sent_at is the next statement, so poll for it
    async with asyncio.timeout(TIMEOUT_S):
        while True:
            conn = await db.connect_as(relay_url, db.RELAY_ROLE)
            try:
                cur = await conn.execute(
                    "select queue, sent_at from outbox where run_id = %s order by id", (run_id,)
                )
                rows = await cur.fetchall()
            finally:
                await conn.close()
            queues = {r["queue"] for r in rows}
            if queues >= {"pre-cpu", "agent", "post-io"} and all(r["sent_at"] is not None for r in rows):
                break
            await asyncio.sleep(0.05)


async def test_relay_queue_filter_leaves_preprocess_unsent(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None
) -> None:
    """The Mac agent claims only ``agent``. A preprocess note stays unsent for the Docker worker."""
    stop = asyncio.Event()
    task = asyncio.create_task(
        relay.run_in_process(stop, FixtureEngines(storage), storage, queues=("agent",))
    )
    try:
        uid = await _signup(api)
        run_id, _, _ = await _start_run(uid, "review", storage)
        await asyncio.sleep(0.4)
        assert (await _status(uid, run_id))["status"] == "queued"
    finally:
        stop.set()
        await asyncio.wait_for(task, TIMEOUT_S)

    relay_url = get_settings().database_url_relay
    assert relay_url
    conn = await db.connect_as(relay_url, db.RELAY_ROLE)
    try:
        cur = await conn.execute(
            "select sent_at from outbox where run_id = %s and queue = 'pre-cpu'", (run_id,)
        )
        row = await cur.fetchone()
    finally:
        await conn.close()
    assert row is not None and row["sent_at"] is None


@pytest.mark.parametrize(
    ("mode", "where", "queue"), [("review", "agent", "agent"), ("auto", "render", "post-io")]
)
async def test_a_failing_stage_marks_the_run_failed_and_frees_the_video(
    api: httpx.AsyncClient, storage: GcsStorage, worker_pool: None, mode: str, where: str, queue: str
) -> None:
    uid = await _signup(api)
    run_id, video_id, ws = await _start_run(uid, mode, storage)
    engines = _Broken(storage, where)
    events: list[Any] = []
    for q in ("pre-cpu", "agent", "post-io"):
        task = Task(task_id=db.task_id(run_id, q, 1), queue=q, run_id=run_id, workspace_id=ws)  # type: ignore[arg-type]
        events = await stages.handle(task, engines, storage)
        if q == queue:
            break
    name, err = events[-1]
    assert name == "run.failed" and err.stage == queue and err.retryable is True
    row = await _status(uid, run_id)
    assert row["status"] == "failed" and row["finished_at"] is not None and row["video_status"] == "failed"
    async with db.tenant_tx(uid) as conn:  # the live-run slot is free again: a new run can start
        await lifecycle.start(conn, video_id=video_id, mode="review", voice="original", voice_id=None)
