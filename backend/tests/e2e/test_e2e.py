"""C-api end to end: sign up, upload to fake-gcs, confirm, start a run, follow SSE to review,
approve, reach done.

Needs the compose services (Postgres, Redis, fake-gcs). A real uvicorn server runs in the test's
event loop, because httpx's ASGI transport buffers whole responses and cannot stream SSE.
"""

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import uvicorn
from google.api_core.exceptions import Conflict

from app.main import create_app
from app.pipeline.fixture_engines import FixtureEngines
from app.pipeline.relay import run_in_process
from app.shared import db
from app.shared.config import get_settings
from app.shared.events import close_redis
from app.shared.storage import get_storage

pytestmark = pytest.mark.asyncio(loop_scope="session")

TIMEOUT_S = 30


@pytest.fixture
async def base_url() -> AsyncIterator[str]:
    storage = get_storage()
    with contextlib.suppress(Conflict):
        await asyncio.to_thread(storage.client.create_bucket, storage.bucket_name)  # type: ignore[attr-defined]

    server = uvicorn.Server(
        uvicorn.Config(create_app(manage_pool=False), host="127.0.0.1", port=0, log_level="warning")
    )
    serving = asyncio.create_task(server.serve())
    await db.open_worker_pool(get_settings().database_url_worker or "")
    stop = asyncio.Event()
    worker = asyncio.create_task(run_in_process(stop, FixtureEngines(storage), storage))
    try:
        while not server.started:  # noqa: ASYNC110 - uvicorn exposes a flag, not an event
            await asyncio.sleep(0.02)
        port = server.servers[0].sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}"
    finally:
        stop.set()
        await asyncio.wait_for(worker, TIMEOUT_S)
        await db.close_worker_pool()
        server.should_exit = True
        await serving
        await close_redis()


async def _events_until(
    c: httpx.AsyncClient, run_id: str, h: dict[str, str], stop_at: str
) -> list[tuple[str, Any]]:
    """Read the SSE stream until a run.status with ``stop_at`` (or a run.done) arrives."""
    seen: list[tuple[str, Any]] = []
    event = None
    async with c.stream("GET", f"/runs/{run_id}/events", headers=h) as r:
        assert r.status_code == 200
        async for line in r.aiter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event:
                data = json.loads(line.split(":", 1)[1])
                seen.append((event, data))
                if event == "run.done" or (event == "run.status" and data["status"] == stop_at):
                    return seen
    return seen


async def test_record_review_approve_done(base_url: str) -> None:
    async with httpx.AsyncClient(base_url=base_url, timeout=TIMEOUT_S) as c:
        email = f"e2e-{uuid.uuid4().hex[:12]}@example.com"
        r = await c.post("/auth/signup", json={"email": email, "password": "correct horse battery"})
        assert r.status_code == 201, r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}

        r = await c.post("/videos", json={"title": "E2E demo"}, headers=h)
        assert r.status_code == 201, r.text
        video_id, upload_url = r.json()["video_id"], r.json()["upload_url"]

        put = await c.put(
            upload_url, content=b"\x1aE\xdf\xa3fake-webm" * 64, headers={"Content-Type": "video/webm"}
        )
        assert put.status_code in (200, 201), put.text

        r = await c.post(f"/videos/{video_id}/uploaded", json={"duration_s": 62.0}, headers=h)
        assert r.status_code == 200 and r.json()["status"] == "uploaded", r.text

        r = await c.post(f"/videos/{video_id}/runs", json={"mode": "review", "voice": "original"}, headers=h)
        assert r.status_code == 202, r.text
        run_id = r.json()["run_id"]

        seen = await asyncio.wait_for(_events_until(c, run_id, h, "awaiting_review"), TIMEOUT_S)
        statuses = [d["status"] for e, d in seen if e == "run.status"]
        assert statuses[-1] == "awaiting_review", seen
        assert any(e == "run.proposal_ready" for e, _ in seen) or statuses[0] == "awaiting_review", seen

        r = await c.get(f"/runs/{run_id}/proposal", headers=h)
        assert r.status_code == 200 and r.json()["proposal"]["version"] == 1, r.text
        assert "gs://" not in r.text

        # a second user sees none of it
        r = await c.post("/auth/signup", json={"email": f"x{email}", "password": "correct horse battery"})
        other = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await c.get(f"/videos/{video_id}", headers=other)).status_code == 404
        assert (await c.get(f"/runs/{run_id}", headers=other)).status_code == 404
        assert (await c.get(f"/runs/{run_id}/events", headers=other)).status_code == 404

        r = await c.post(f"/runs/{run_id}/approve", headers=h)
        assert r.status_code == 202, r.text

        seen = await asyncio.wait_for(_events_until(c, run_id, h, "done"), TIMEOUT_S)
        done = [d for e, d in seen if e == "run.done"]
        if done:
            assert done[0]["video_id"] == video_id and not done[0]["output_uri"].startswith("gs://")

        r = await c.get(f"/runs/{run_id}", headers=h)
        assert r.json()["status"] == "done", r.text
        r = await c.get(f"/videos/{video_id}", headers=h)
        assert r.json()["status"] == "ready" and r.json()["playback_url"], r.text
