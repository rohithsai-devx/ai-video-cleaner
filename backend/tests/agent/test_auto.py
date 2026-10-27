"""A capped auto run stops on review. The graph's accepted flag is what the stage reads."""

import dataclasses
import uuid
from collections.abc import AsyncIterator
from uuid import UUID

import httpx
import jwt
import pytest
from psycopg.types.json import Jsonb

from app.contracts.events import RunProposalReadyEvent, RunStatusEvent
from app.pipeline.media_engines import MediaEngines
from app.pipeline.stages import Task, handle
from app.runs import lifecycle
from app.shared import db
from app.shared.config import get_settings
from app.shared.storage import GcsStorage
from tests.agent.test_graph import Scripted, clip, good_plan, good_script

pytestmark = pytest.mark.asyncio(loop_scope="session")

PASSWORD = "correct horse battery"


@pytest.fixture
async def worker_pool() -> AsyncIterator[None]:
    url = get_settings().database_url_worker
    assert url, "DATABASE_URL_WORKER must be set"
    await db.open_worker_pool(url)
    try:
        yield
    finally:
        await db.close_worker_pool()


async def test_capped_auto_run_stops_for_review(client: httpx.AsyncClient, worker_pool: None) -> None:
    email = f"a-{uuid.uuid4().hex[:12]}@example.com"
    response = await client.post("/auth/signup", json={"email": email, "password": PASSWORD, "name": "A"})
    assert response.status_code == 201, response.text
    user_id = UUID(jwt.decode(response.json()["access_token"], options={"verify_signature": False})["sub"])
    video_id = uuid.uuid4()
    pre = clip()
    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "insert into videos (id, workspace_id, owner_id, raw_uri, status)"
            " select %s, workspace_id, %s, %s, 'uploaded' from workspace_members where user_id = %s limit 1"
            " returning workspace_id",
            (video_id, user_id, f"gs://b/videos/{video_id}/raw.webm", user_id),
        )
        row = await cur.fetchone()
        assert row is not None
        workspace_id = row["workspace_id"]
        run, _events = await lifecycle.start(
            conn, video_id=video_id, mode="auto", voice="original", voice_id=None
        )

    async with db.worker_tx(workspace_id) as conn:
        loaded = await lifecycle.load(conn, run.id)
        assert loaded is not None and loaded.status == "queued"
        await lifecycle.advance(conn, loaded, "preprocessing", stage="preprocess")
        loaded = dataclasses.replace(loaded, status="preprocessing", stage="preprocess")
        await lifecycle.advance(conn, loaded, "agent_running", stage="agent")
        await conn.execute(
            "update runs set pre = %s where id = %s",
            (Jsonb(pre.model_dump(mode="json")), run.id),
        )

    bundle = Scripted(
        script=good_script(pre, text="alpha 99"),
        plan=good_plan(pre),
        p_yes=0.99,
        spot_ideas=[
            {
                "span": [0.0, 4.0],
                "question": "Should this phrase stay in the video?",
                "fixes": [
                    {
                        "label": "Use a clearer line",
                        "patch": {"block": {"block_id": "b1", "text": "Alpha and beta."}},
                    }
                ],
            }
        ],
    )
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")
    events = await handle(
        Task(task_id="agent-1", queue="agent", run_id=run.id, workspace_id=workspace_id, attempt=1),
        MediaEngines(storage, bundle=bundle),
        storage,
    )
    ready = next(payload for name, payload in events if name == "run.proposal_ready")
    assert isinstance(ready, RunProposalReadyEvent)
    statuses = [
        payload.status
        for name, payload in events
        if name == "run.status" and isinstance(payload, RunStatusEvent)
    ]
    assert ready.auto_approved is False
    assert ready.flags == ["max_attempts"]
    assert statuses == ["awaiting_review"]

    async with db.tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "select r.status, r.flags, v.status as video_status from runs r"
            " join videos v on v.id = r.video_id where r.id = %s",
            (run.id,),
        )
        saved = await cur.fetchone()
        assert saved is not None
        assert saved["status"] == "awaiting_review"
        assert saved["video_status"] == "awaiting_review"
        assert saved["flags"] == ["max_attempts"]
        cur = await conn.execute(
            "select version, source, edit_plan, spots from proposals where run_id = %s", (run.id,)
        )
        proposals = await cur.fetchall()
    assert [(row["version"], row["source"]) for row in proposals] == [(1, "agent")]
    # A capped script still ships a complete cut list, or approval is a dead end in the UI.
    assert len(proposals[0]["edit_plan"]["entries"]) > 0
    assert proposals[0]["spots"][0]["question"] == "Should this phrase stay in the video?"
