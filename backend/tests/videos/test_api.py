"""C-api: routers against the compose Postgres, with a storage double and recorded SSE publishes."""

import json
import uuid
from typing import Any

import httpx
import pytest

from app.contracts.events import RunStatusEvent
from app.shared.config import MAX_RECORDING_SECONDS, get_settings

# ruff: noqa: F401, F811  (fixtures come from tests.factories and are requested by name)
from tests.factories import (
    FIXTURE,
    PASSWORD,
    FakeStorage,
    _run_awaiting_review,
    _uploaded_video,
    _user,
    api,
    published,
    storage,
    worker_tx,
)

pytestmark = pytest.mark.asyncio(loop_scope="session")


async def test_video_upload_confirm(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    r = await api.post("/videos", json={"title": "Demo"}, headers=h)
    assert r.status_code == 201
    vid = r.json()["video_id"]
    assert r.json()["upload_url"].startswith("http")
    assert r.json()["poster_upload_url"].startswith("http")
    assert storage.sessions == [storage.raw_uri(vid), storage.poster_uri(vid)]

    r = await api.post(f"/videos/{vid}/uploaded", headers=h)
    assert r.status_code == 409  # object not in storage yet

    storage.objects.add(storage.raw_uri(vid))
    r = await api.post(f"/videos/{vid}/uploaded", json={"duration_s": 61.5}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "uploaded" and body["duration_s"] == 61.5
    assert "raw_uri" not in body and "gs://" not in r.text
    assert body["poster_url"] is None  # no poster uploaded: the video still confirms

    r = await api.get(f"/videos/{vid}", headers=h)
    assert r.status_code == 200 and r.json()["current_run"] is None

    r = await api.get("/videos", headers=h)
    assert r.status_code == 200 and [v["id"] for v in r.json()["items"]] == [vid]


async def test_video_poster_url_after_upload(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    vid = (await api.post("/videos", json={}, headers=h)).json()["video_id"]
    storage.objects.update({storage.raw_uri(vid), storage.poster_uri(vid)})
    r = await api.post(f"/videos/{vid}/uploaded", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["poster_url"] == f"http://fake-play/videos/{vid}/poster.jpg"
    assert (await api.get(f"/videos/{vid}", headers=h)).json()["poster_url"] == r.json()["poster_url"]
    assert (await api.get("/videos", headers=h)).json()["items"][0]["poster_url"] == r.json()["poster_url"]


async def test_video_poster_failures_do_not_fail_upload(
    api: httpx.AsyncClient, storage: FakeStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    h = await _user(api)
    real_session, real_exists = storage.upload_session, storage.exists

    async def flaky_session(uri: str, content_type: str) -> str:
        if uri.endswith("poster.jpg"):
            raise RuntimeError("poster session down")
        return await real_session(uri, content_type)

    async def flaky_exists(uri: str) -> bool:
        if uri.endswith("poster.jpg"):
            raise RuntimeError("poster lookup down")
        return await real_exists(uri)

    monkeypatch.setattr(storage, "upload_session", flaky_session)
    monkeypatch.setattr(storage, "exists", flaky_exists)
    r = await api.post("/videos", json={}, headers=h)
    assert r.status_code == 201 and r.json()["poster_upload_url"] is None
    vid = r.json()["video_id"]
    storage.objects.add(storage.raw_uri(vid))
    r = await api.post(f"/videos/{vid}/uploaded", headers=h)
    assert r.status_code == 200 and r.json()["poster_url"] is None


async def test_video_list_paginates(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    ids = [(await api.post("/videos", json={}, headers=h)).json()["video_id"] for _ in range(3)]
    r = await api.get("/videos", params={"limit": 2}, headers=h)
    page1 = r.json()
    assert len(page1["items"]) == 2 and page1["next_cursor"]
    r = await api.get("/videos", params={"limit": 2, "cursor": page1["next_cursor"]}, headers=h)
    page2 = r.json()
    assert page2["next_cursor"] is None
    assert [v["id"] for v in page1["items"] + page2["items"]] == list(reversed(ids))


async def test_start_run_and_second_live_run_conflicts(
    api: httpx.AsyncClient, storage: FakeStorage, published: list[Any]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    body = {"mode": "review", "voice": "original"}
    r = await api.post(f"/videos/{video['id']}/runs", json=body, headers=h)
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    assert (await api.post(f"/videos/{video['id']}/runs", json=body, headers=h)).status_code == 409

    r = await api.get(f"/runs/{run_id}", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "queued"
    v = (await api.get(f"/videos/{video['id']}", headers=h)).json()
    assert v["status"] == "processing" and v["current_run"]["run_id"] == run_id
    assert (run_id, "run.status", RunStatusEvent(status="queued")) in [(rid, e, p) for rid, e, p in published]

    r = await api.post(f"/runs/{run_id}/cancel", headers=h)
    assert r.status_code == 202
    assert (await api.get(f"/runs/{run_id}", headers=h)).json()["status"] == "cancelled"
    assert (await api.post(f"/runs/{run_id}/cancel", headers=h)).status_code == 409


async def test_run_requires_uploaded_video(api: httpx.AsyncClient) -> None:
    h = await _user(api)
    vid = (await api.post("/videos", json={}, headers=h)).json()["video_id"]
    r = await api.post(f"/videos/{vid}/runs", json={"mode": "auto", "voice": "original"}, headers=h)
    assert r.status_code == 409


async def test_proposal_edit_and_approve(
    api: httpx.AsyncClient, storage: FakeStorage, published: list[Any]
) -> None:
    h = await _user(api)
    _, run_id = await _run_awaiting_review(api, h, storage)

    r = await api.get(f"/runs/{run_id}/proposal", headers=h)
    assert r.status_code == 200, r.text
    view = r.json()
    assert view["proposal"]["version"] == 1 and view["proposal"]["flags"] == FIXTURE["flags"]
    assert view["keyframes"] == [{"frame_id": "f1", "t": 1.0, "url": "http://fake-play/runs/x/f1.jpg"}]
    assert "gs://" not in r.text

    p = view["proposal"]
    # Same words as the source, minus the greeting, so length and clean-only still pass.
    p["script"]["blocks"][0]["text"] = "today I'll show you how to export the quarterly report."
    update = {
        "base_version": p["version"],
        "script": p["script"],
        "edit_plan": p["edit_plan"],
        "seg_contexts": p["seg_contexts"],
    }
    r = await api.put(f"/runs/{run_id}/proposal", json=update, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["proposal"]["version"] == 2 and r.json()["proposal"]["source"] == "user"

    # an EDL that breaks the render is saved (with a failed check) but cannot be approved
    bad = json.loads(json.dumps(update))
    bad["edit_plan"]["entries"][0]["action"] = "speed"
    bad["edit_plan"]["entries"][0]["speed"] = 5.0
    bad["base_version"] = 2
    r = await api.put(f"/runs/{run_id}/proposal", json=bad, headers=h)
    assert r.status_code == 200
    checks = {c["name"]: c["passed"] for c in r.json()["proposal"]["checks"]}
    assert checks["edl_valid"] is False
    assert (await api.post(f"/runs/{run_id}/approve", headers=h)).status_code == 422

    update["base_version"] = 3
    r = await api.put(f"/runs/{run_id}/proposal", json=update, headers=h)
    assert r.json()["proposal"]["version"] == 4
    r = await api.post(f"/runs/{run_id}/approve", headers=h)
    assert r.status_code == 202, r.text
    assert (await api.get(f"/runs/{run_id}", headers=h)).json()["status"] == "approved"
    assert (await api.post(f"/runs/{run_id}/approve", headers=h)).status_code == 409
    assert (await api.put(f"/runs/{run_id}/proposal", json=update, headers=h)).status_code == 409
    assert published[-1][1:] == ("run.status", RunStatusEvent(status="approved", stage="approved"))


async def test_share_and_public_page(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    r = await api.post(f"/videos/{video['id']}/shares", json={}, headers=h)
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    assert r.json()["url"] == f"{get_settings().frontend_base_url.rstrip('/')}/s/{slug}"
    assert (await api.get(f"/s/{slug}")).status_code == 404  # not ready yet

    key = f"videos/{video['id']}/final.mp4"
    uri = f"gs://test-bucket/{key}"
    storage.objects.add(uri)
    async with worker_tx(video["workspace_id"]) as w:
        await w.execute(
            "update videos set status = 'ready', output_uri = %s where id = %s",
            (uri, video["id"]),
        )
    r = await api.get(f"/s/{slug}")
    assert r.status_code == 200, r.text
    assert r.json() == {"title": "Demo", "playback_url": f"http://fake-play/{key}", "poster_url": None}
    v = (await api.get(f"/videos/{video['id']}", headers=h)).json()
    assert v["playback_url"] == f"http://fake-play/{key}"


async def test_other_tenant_gets_404(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    a = await _user(api)
    video, run_id = await _run_awaiting_review(api, a, storage)
    vid = video["id"]
    b = await _user(api)
    calls = [
        ("GET", f"/videos/{vid}", None),
        ("POST", f"/videos/{vid}/uploaded", None),
        ("POST", f"/videos/{vid}/runs", {"mode": "review", "voice": "original"}),
        ("POST", f"/videos/{vid}/shares", {}),
        ("GET", f"/runs/{run_id}", None),
        ("GET", f"/runs/{run_id}/proposal", None),
        ("POST", f"/runs/{run_id}/approve", None),
        ("POST", f"/runs/{run_id}/cancel", None),
    ]
    for method, path, body in calls:
        r = await api.request(method, path, json=body, headers=b)
        assert r.status_code == 404, (method, path, r.status_code, r.text)
    assert (await api.get("/videos", headers=b)).json()["items"] == []
    assert (await api.get(f"/runs/{run_id}", headers=a)).json()["status"] == "awaiting_review"


async def test_unknown_ids_and_auth(api: httpx.AsyncClient) -> None:
    assert (await api.get(f"/videos/{uuid.uuid4()}")).status_code == 401
    h = await _user(api)
    assert (await api.get(f"/runs/{uuid.uuid4()}", headers=h)).status_code == 404
    assert (await api.get("/s/doesnotexist0")).status_code == 404


async def test_uploaded_rejects_overlong_recording(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    vid = (await api.post("/videos", json={"title": "Long"}, headers=h)).json()["video_id"]
    storage.objects.add(storage.raw_uri(vid))
    limit = MAX_RECORDING_SECONDS
    r = await api.post(f"/videos/{vid}/uploaded", json={"duration_s": limit + 1}, headers=h)
    assert r.status_code == 422
    r = await api.post(f"/videos/{vid}/uploaded", json={"duration_s": limit}, headers=h)
    assert r.status_code == 200, r.text


async def test_me_returns_user_and_workspaces(api: httpx.AsyncClient) -> None:
    assert (await api.get("/me")).status_code == 401
    h = await _user(api)
    r = await api.get("/me", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"].endswith("@example.com") and body["user"]["name"] == "T"
    assert [w["role"] for w in body["workspaces"]] == ["owner"]
    assert set(body["workspaces"][0]) == {"id", "name", "role"}
    other = await _user(api)
    assert (await api.get("/me", headers=other)).json()["user"]["id"] != body["user"]["id"]


async def test_playback_url_is_the_raw_upload_until_there_is_an_output(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h = await _user(api)
    video, _ = await _run_awaiting_review(api, h, storage)
    vid = video["id"]
    raw = f"http://fake-play/videos/{vid}/raw.webm"
    assert video["playback_url"] == raw  # uploaded, from the confirm response
    assert (await api.get(f"/videos/{vid}", headers=h)).json()["playback_url"] == raw
    assert (await api.get("/videos", headers=h)).json()["items"][0]["playback_url"] == raw
