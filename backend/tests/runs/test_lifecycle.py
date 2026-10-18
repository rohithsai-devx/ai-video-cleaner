"""Lifecycle at its interface: start, the compare-and-set in advance, and what entering each status does.

Runs against the compose Postgres (DATABASE_URL_API, DATABASE_URL_WORKER).
"""
# ruff: noqa: F401, F811  (fixtures are imported from test_api and requested by name)

from typing import Any
from uuid import UUID

import httpx
import pytest

from app.auth.security import decode_token
from app.contracts.events import RunFailedEvent, RunStatusEvent
from app.runs import lifecycle
from app.runs.lifecycle import LiveRunExists, Lost, VideoNotStartable
from app.shared.db import task_id, tenant_tx
from tests.factories import FakeStorage, _uploaded_video, _user, api, published, storage, worker_tx


@pytest.fixture
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, int, str]]:
    """Record (queue, stage, attempt, task_id) for every outbox row lifecycle writes."""
    calls: list[tuple[str, str, int, str]] = []
    real = lifecycle.enqueue

    async def spy(conn: Any, **kw: Any) -> str:
        tid = await real(conn, **kw)
        calls.append((kw["queue"], kw["stage"], kw["attempt"], tid))
        return tid

    monkeypatch.setattr(lifecycle, "enqueue", spy)
    return calls


def _uid(h: dict[str, str]) -> UUID:
    return decode_token(h["Authorization"].removeprefix("Bearer "))


async def _start(uid: UUID, video_id: UUID, mode: str = "review") -> lifecycle.RunRef:
    voice = "original"
    async with tenant_tx(uid) as conn:
        ref, events = await lifecycle.start(conn, video_id=video_id, mode=mode, voice=voice, voice_id=None)  # type: ignore[arg-type]
    assert events == [("run.status", RunStatusEvent(status="queued"))]
    return ref


async def _advance_as_api(uid: UUID, run_id: UUID, to: str, **kw: Any) -> list[Any]:
    async with tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        return await lifecycle.advance(conn, run, to, **kw)  # type: ignore[arg-type]


async def _advance_as_worker(workspace_id: str, run_id: UUID, to: str, **kw: Any) -> list[Any]:
    async with worker_tx(workspace_id) as w:
        run = await lifecycle.load(w, run_id)
        assert run is not None
        return await lifecycle.advance(w, run, to, **kw)  # type: ignore[arg-type]


async def test_start_queues_run_and_enqueues_pre_cpu(
    api: httpx.AsyncClient, storage: FakeStorage, enqueued: list[Any]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ref = await _start(_uid(h), UUID(video["id"]))

    assert (ref.status, ref.stage, ref.attempt, ref.duration_s) == ("queued", None, 1, 62.0)
    assert enqueued == [("pre-cpu", "pre-cpu", 1, task_id(ref.id, "pre-cpu", 1))]
    body = (await api.get(f"/videos/{video['id']}", headers=h)).json()
    assert body["status"] == "processing"
    assert body["current_run"]["run_id"] == str(ref.id)


async def test_start_refuses_a_video_without_an_upload(api: httpx.AsyncClient) -> None:
    h = await _user(api)
    vid = UUID((await api.post("/videos", json={"title": "x"}, headers=h)).json()["video_id"])
    with pytest.raises(VideoNotStartable) as e:
        await _start(_uid(h), vid)
    assert e.value.status == "uploading"


async def test_second_live_run_is_refused(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    vid = UUID(video["id"])
    await _start(_uid(h), vid)
    # a video is only startable again once its live run is gone; simulate a stale status to reach the index
    async with worker_tx(video["workspace_id"]) as w:
        await w.execute("update videos set status = 'uploaded' where id = %s", (vid,))
    with pytest.raises(LiveRunExists):
        await _start(_uid(h), vid)


async def test_stale_ref_loses_the_compare_and_set(
    api: httpx.AsyncClient, storage: FakeStorage, enqueued: list[Any]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ref = await _start(_uid(h), UUID(video["id"]))
    async with worker_tx(video["workspace_id"]) as w:
        await lifecycle.advance(w, ref, "preprocessing")  # the winner
        with pytest.raises(Lost):
            await lifecycle.advance(w, ref, "preprocessing")  # ref still says queued: 0 rows
        current = await lifecycle.get(w, ref.id)
    assert current is not None and current.status == "preprocessing" and current.started_at is not None


async def test_cancel_returns_video_to_uploaded_when_no_output(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ref = await _start(_uid(h), UUID(video["id"]))
    events = await _advance_as_api(_uid(h), ref.id, "cancelled")
    assert events == [("run.status", RunStatusEvent(status="cancelled", stage=None))]
    body = (await api.get(f"/videos/{video['id']}", headers=h)).json()
    assert body["status"] == "uploaded" and body["current_run"]["status"] == "cancelled"


async def test_done_requires_output_and_marks_video_ready(
    api: httpx.AsyncClient, storage: FakeStorage, enqueued: list[Any]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ws, vid = video["workspace_id"], video["id"]
    ref = await _start(_uid(h), UUID(vid), mode="auto")
    for to in ("preprocessing", "agent_running", "approved", "postprocessing"):
        await _advance_as_worker(ws, ref.id, to)
    assert [q for q, *_ in enqueued] == ["pre-cpu", "agent", "post-io"]

    async with worker_tx(ws) as w:
        run = await lifecycle.load(w, ref.id)
        assert run is not None
        with pytest.raises(ValueError):
            await lifecycle.advance(w, run, "done")

    out = f"gs://test-bucket/videos/{vid}/runs/{ref.id}/post/v1/final.mp4"
    events = await _advance_as_worker(ws, ref.id, "done", output_uri=out)
    assert events == [("run.status", RunStatusEvent(status="done", stage=None))]
    assert (await api.get(f"/videos/{vid}", headers=h)).json()["status"] == "ready"


async def test_awaiting_review_moves_the_video_to_awaiting_review(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ref = await _start(_uid(h), UUID(video["id"]))
    for to in ("preprocessing", "agent_running", "awaiting_review"):
        await _advance_as_worker(video["workspace_id"], ref.id, to)
    assert (await api.get(f"/videos/{video['id']}", headers=h)).json()["status"] == "awaiting_review"


async def test_failed_requires_an_error_and_records_it(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    ws, vid = video["workspace_id"], video["id"]
    ref = await _start(_uid(h), UUID(vid))
    await _advance_as_worker(ws, ref.id, "preprocessing")
    with pytest.raises(ValueError):
        await _advance_as_worker(ws, ref.id, "failed")
    err = RunFailedEvent(stage="preprocess", message="ffmpeg exited 1", retryable=True)
    await _advance_as_worker(ws, ref.id, "failed", error=err)
    run = (await api.get(f"/runs/{ref.id}", headers=h)).json()
    assert run["status"] == "failed" and run["finished_at"] is not None
    assert RunFailedEvent.model_validate(run["error"]) == err
    assert (await api.get(f"/videos/{vid}", headers=h)).json()["status"] == "failed"
