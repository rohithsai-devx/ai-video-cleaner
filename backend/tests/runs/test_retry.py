"""Run retries through the public API and their lifecycle side effects."""
# ruff: noqa: F401, F811  (fixtures are imported from tests.factories and requested by name)

from typing import Any
from uuid import UUID

import httpx
import pytest

from app.contracts.events import RunFailedEvent
from app.runs import lifecycle
from app.shared import db
from app.shared.config import get_settings
from app.shared.db import tenant_tx
from tests.factories import FakeStorage, _uploaded_video, _user, api, published, storage, worker_tx

pytestmark = pytest.mark.asyncio(loop_scope="session")


def _uid(headers: dict[str, str]) -> UUID:
    from app.auth.security import decode_token

    return decode_token(headers["Authorization"].removeprefix("Bearer "))


async def _start(uid: UUID, video_id: UUID) -> lifecycle.RunRef:
    async with tenant_tx(uid) as conn:
        run, _ = await lifecycle.start(
            conn, video_id=video_id, mode="review", voice="original", voice_id=None
        )
    return run


async def _advance_worker(workspace_id: str, run_id: UUID, status: str, **kwargs: Any) -> None:
    async with worker_tx(workspace_id) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        await lifecycle.advance(conn, run, status, **kwargs)  # type: ignore[arg-type]


async def _failed_run(
    uid: UUID,
    video: dict[str, Any],
    *,
    stage: str | None,
    retryable: bool = True,
) -> lifecycle.RunRef:
    run = await _start(uid, UUID(video["id"]))
    workspace_id = video["workspace_id"]
    if stage == "agent":
        await _advance_worker(workspace_id, run.id, "preprocessing", stage="preprocess")
        await _advance_worker(workspace_id, run.id, "agent_running", stage="agent")
    elif stage in {"approved", "render"}:
        await _advance_worker(workspace_id, run.id, "preprocessing", stage="preprocess")
        await _advance_worker(workspace_id, run.id, "agent_running", stage="agent")
        await _advance_worker(workspace_id, run.id, "approved", stage="approved")
        await _advance_worker(workspace_id, run.id, "postprocessing", stage="render")

    error_stage = stage or "preprocess"
    await _advance_worker(
        workspace_id,
        run.id,
        "failed",
        **({"stage": stage} if stage is not None else {}),
        error=RunFailedEvent(stage=error_stage, message="temporary test failure", retryable=retryable),
    )
    return run


async def _outbox_rows(run_id: UUID) -> list[dict[str, Any]]:
    url = get_settings().database_url_relay
    assert url is not None
    conn = await db.connect_as(url, db.RELAY_ROLE)
    try:
        cur = await conn.execute(
            "select queue, task_id, payload from outbox where run_id = %s order by id", (run_id,)
        )
        return await cur.fetchall()
    finally:
        await conn.close()


async def _retry(api: httpx.AsyncClient, headers: dict[str, str], run_id: UUID) -> httpx.Response:
    return await api.post(f"/runs/{run_id}/retry", headers=headers)


async def test_retry_preprocess_failure_sets_started_at_and_enqueues_attempt_two(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    run = await _failed_run(_uid(headers), video, stage=None)
    before = (await api.get(f"/runs/{run.id}", headers=headers)).json()
    assert before["started_at"] is None

    response = await _retry(api, headers, run.id)

    assert response.status_code == 202, response.text
    assert response.json() == {"run_id": str(run.id), "status": "preprocessing", "stage": "preprocess"}
    current = (await api.get(f"/runs/{run.id}", headers=headers)).json()
    assert current["attempt"] == 2
    assert current["status"] == "preprocessing" and current["stage"] == "preprocess"
    assert current["started_at"] is not None and current["finished_at"] is None and current["error"] is None
    assert (await api.get(f"/videos/{video['id']}", headers=headers)).json()["status"] == "processing"
    rows = await _outbox_rows(run.id)
    attempt_two = [row for row in rows if row["payload"].get("attempt") == 2]
    assert len(attempt_two) == 1
    assert attempt_two[0]["queue"] == "pre-cpu"
    assert attempt_two[0]["payload"] == {
        "run_id": str(run.id),
        "video_id": video["id"],
        "attempt": 2,
    }


@pytest.mark.parametrize(
    ("failed_stage", "status", "stage", "video_status", "queue"),
    [
        ("preprocess", "preprocessing", "preprocess", "processing", "pre-cpu"),
        ("agent", "agent_running", "agent", "processing", "agent"),
        ("approved", "postprocessing", "render", "rendering", "post-io"),
        ("render", "postprocessing", "render", "rendering", "post-io"),
    ],
)
async def test_retry_uses_the_failed_run_stage(
    api: httpx.AsyncClient,
    storage: FakeStorage,
    failed_stage: str,
    status: str,
    stage: str,
    video_status: str,
    queue: str,
) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    run = await _failed_run(_uid(headers), video, stage=failed_stage)

    response = await _retry(api, headers, run.id)

    assert response.status_code == 202, response.text
    assert response.json() == {"run_id": str(run.id), "status": status, "stage": stage}
    current = (await api.get(f"/runs/{run.id}", headers=headers)).json()
    assert current["attempt"] == 2 and current["status"] == status and current["stage"] == stage
    assert (await api.get(f"/videos/{video['id']}", headers=headers)).json()["status"] == video_status
    attempt_two = [row for row in await _outbox_rows(run.id) if row["payload"].get("attempt") == 2]
    assert len(attempt_two) == 1 and attempt_two[0]["queue"] == queue


async def test_retry_can_repeat_after_another_failure(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    run = await _failed_run(_uid(headers), video, stage="preprocess")

    first = await _retry(api, headers, run.id)
    assert first.status_code == 202, first.text
    after_first = (await api.get(f"/runs/{run.id}", headers=headers)).json()
    assert after_first["attempt"] == 2
    assert after_first["finished_at"] is None and after_first["error"] is None
    await _advance_worker(
        video["workspace_id"],
        run.id,
        "failed",
        stage="preprocess",
        error=RunFailedEvent(stage="1", message="again", retryable=True),
    )

    second = await _retry(api, headers, run.id)

    assert second.status_code == 202, second.text
    current = (await api.get(f"/runs/{run.id}", headers=headers)).json()
    assert current["attempt"] == 3 and current["status"] == "preprocessing"
    assert current["started_at"] is not None and current["finished_at"] is None and current["error"] is None
    attempt_numbers = sorted(row["payload"]["attempt"] for row in await _outbox_rows(run.id))
    assert attempt_numbers == [1, 2, 3]


async def test_retry_of_live_run_conflicts_without_changing_outbox(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    run = await _start(_uid(headers), UUID(video["id"]))
    before = await _outbox_rows(run.id)

    response = await _retry(api, headers, run.id)

    assert response.status_code == 409 and response.json()["detail"]["code"] == "run_not_failed"
    assert await _outbox_rows(run.id) == before


async def test_retry_of_superseded_run_conflicts_without_changing_outbox(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    uid = _uid(headers)
    old = await _failed_run(uid, video, stage=None)
    before = await _outbox_rows(old.id)
    await _start(uid, UUID(video["id"]))

    response = await _retry(api, headers, old.id)

    assert response.status_code == 409 and response.json()["detail"]["code"] == "run_not_current"
    assert await _outbox_rows(old.id) == before


@pytest.mark.parametrize(("failed_stage", "retryable"), [("agent", False), ("unknown", True)])
async def test_unretryable_failure_conflicts_without_changing_outbox(
    api: httpx.AsyncClient, storage: FakeStorage, failed_stage: str, retryable: bool
) -> None:
    headers = await _user(api)
    video = await _uploaded_video(api, headers, storage)
    run = await _failed_run(_uid(headers), video, stage=failed_stage, retryable=retryable)
    before = await _outbox_rows(run.id)

    response = await _retry(api, headers, run.id)

    assert response.status_code == 409 and response.json()["detail"]["code"] == "not_retryable"
    assert await _outbox_rows(run.id) == before


async def test_retry_of_hidden_run_is_not_found(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    owner = await _user(api)
    video = await _uploaded_video(api, owner, storage)
    run = await _failed_run(_uid(owner), video, stage=None)
    stranger = await _user(api)

    response = await _retry(api, stranger, run.id)

    assert response.status_code == 404
