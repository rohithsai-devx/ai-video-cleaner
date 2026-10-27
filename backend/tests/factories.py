"""Shared test helpers: fake storage, tenant users, worker transactions, and run and video fixtures."""

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pydantic import BaseModel

import app.shared.events
from app.main import create_app
from app.shared.config import get_settings
from app.shared.storage import get_storage

pytestmark = pytest.mark.asyncio(loop_scope="session")


FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "app" / "pipeline" / "fixtures" / "proposal.json").read_text()
)


def _align_estimates(fixture: dict[str, Any]) -> None:
    """Keep est_dur within 0.5s of the kept edit so edl_covers_script accepts this fixture."""
    entries = {e["seg_id"]: e for e in fixture["edit_plan"]["entries"]}
    for block in fixture["script"]["blocks"]:
        edited = 0.0
        for seg_id in block["seg_ids"]:
            entry = entries[seg_id]
            if entry["action"] == "cut":
                continue
            start, end = entry["src"]
            edited += (end - start) / entry["speed"] + entry["freeze_s"]
        block["est_dur"] = edited


def _transcript(script: dict[str, Any]) -> list[dict[str, float | str]]:
    """One timed token per block word, inside that block's source span."""
    words: list[dict[str, float | str]] = []
    for block in script["blocks"]:
        start, end = block["source_span"]
        tokens = block["text"].split()
        if not tokens:
            continue
        step = (end - start) / len(tokens)
        for i, token in enumerate(tokens):
            words.append({"w": token, "start": start + i * step, "end": start + (i + 1) * step})
    return words


_align_estimates(FIXTURE)


PASSWORD = "correct horse battery"


class FakeStorage:
    """Stands in for GcsStorage: objects are gs:// URIs, as the API passes them."""

    bucket_name = "test-bucket"

    def __init__(self) -> None:
        self.objects: set[str] = set()
        self.sessions: list[str] = []

    def raw_uri(self, video_id: Any) -> str:
        return f"gs://{self.bucket_name}/videos/{video_id}/raw.webm"

    def poster_uri(self, video_id: Any) -> str:
        return f"gs://{self.bucket_name}/videos/{video_id}/poster.jpg"

    async def upload_session(self, uri: str, content_type: str) -> str:
        self.sessions.append(uri)
        return f"http://fake-upload/{uri}"

    async def exists(self, uri: str) -> bool:
        return uri in self.objects

    async def sign(self, *uris: str | None) -> list[str | None]:
        return [
            f"http://fake-play/{uri.partition('://')[2].partition('/')[2]}" if uri in self.objects else None
            for uri in uris
        ]


@pytest.fixture
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, BaseModel]]:
    calls: list[tuple[str, str, BaseModel]] = []

    async def fake_publish(run_id: Any, event: str, payload: BaseModel) -> None:
        calls.append((str(run_id), event, payload))

    monkeypatch.setattr(app.shared.events, "publish", fake_publish)
    return calls


@pytest.fixture
async def api(storage: FakeStorage, published: list[Any]) -> AsyncIterator[httpx.AsyncClient]:
    application = create_app(manage_pool=False)
    application.dependency_overrides[get_storage] = lambda: storage
    transport = httpx.ASGITransport(app=application)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _user(c: httpx.AsyncClient) -> dict[str, str]:
    email = f"u-{uuid.uuid4().hex[:12]}@example.com"
    r = await c.post("/auth/signup", json={"email": email, "password": PASSWORD, "name": "T"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@asynccontextmanager
async def worker_tx(workspace_id: str) -> AsyncIterator[psycopg.AsyncConnection[Any]]:
    """Act as app_worker for one workspace, the way real workers do."""
    url = get_settings().database_url_worker
    assert url, "DATABASE_URL_WORKER must be set"
    async with await psycopg.AsyncConnection.connect(url) as conn:
        async with conn.transaction():
            await conn.execute("select set_config('app.workspace_id', %s, true)", (workspace_id,))
            yield conn


async def _uploaded_video(c: httpx.AsyncClient, h: dict[str, str], storage: FakeStorage) -> dict[str, Any]:
    r = await c.post("/videos", json={"title": "Demo"}, headers=h)
    assert r.status_code == 201, r.text
    vid = r.json()["video_id"]
    storage.objects.add(storage.raw_uri(vid))
    r = await c.post(f"/videos/{vid}/uploaded", json={"duration_s": 62.0}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _run_awaiting_review(
    c: httpx.AsyncClient,
    h: dict[str, str],
    storage: FakeStorage,
    *,
    fix_options: dict[str, bool] | None = None,
) -> tuple[dict[str, Any], str]:
    video = await _uploaded_video(c, h, storage)
    run_body: dict[str, Any] = {"mode": "review", "voice": "original"}
    if fix_options is not None:
        run_body["fix_options"] = fix_options
    r = await c.post(f"/videos/{video['id']}/runs", json=run_body, headers=h)
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    pre = {
        "duration": 62.0,
        "keyframes": [{"frame_id": "f1", "t": 1.0, "uri": "gs://b/runs/x/f1.jpg"}],
        "words": _transcript(FIXTURE["script"]),
    }
    storage.objects.add("gs://b/runs/x/f1.jpg")
    async with worker_tx(video["workspace_id"]) as w:
        for old, new in [("queued", "preprocessing"), ("preprocessing", "agent_running")]:
            cur = await w.execute(
                "update runs set status = %s where id = %s and status = %s", (new, run_id, old)
            )
            assert cur.rowcount == 1
        await w.execute(
            "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
            " seg_contexts, transcript_ctx, checks) values (%s, %s, 1, 'agent', %s, %s, %s, %s, %s)",
            (
                video["workspace_id"],
                run_id,
                Jsonb(FIXTURE["script"]),
                Jsonb(FIXTURE["edit_plan"]),
                Jsonb(FIXTURE["seg_contexts"]),
                Jsonb(FIXTURE["transcript_ctx"]),
                Jsonb(FIXTURE["checks"]),
            ),
        )
        await w.execute(
            "update runs set status = 'awaiting_review', pre = %s, flags = %s where id = %s",
            (Jsonb(pre), Jsonb(FIXTURE["flags"]), run_id),
        )
    return video, run_id
