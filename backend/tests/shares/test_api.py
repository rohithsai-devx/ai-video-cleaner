"""Share link creation and listing through the authenticated API."""

import httpx
import pytest

# ruff: noqa: F401, F811  (fixtures come from tests.factories and are requested by name)
from tests.factories import FakeStorage, _uploaded_video, _user, api, published, storage

pytestmark = pytest.mark.asyncio(loop_scope="session")


async def test_share_creation_is_idempotent_and_list_is_newest_first(
    api: httpx.AsyncClient, storage: FakeStorage, published: list[object]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    path = f"/videos/{video['id']}/shares"

    expired = await api.post(
        path,
        json={"expires_at": "2000-01-01T00:00:00Z"},
        headers=h,
    )
    assert expired.status_code == 201, expired.text

    active = await api.post(path, json={}, headers=h)
    assert active.status_code == 201, active.text
    duplicate = await api.post(path, json={}, headers=h)
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["slug"] == active.json()["slug"]
    assert duplicate.json()["kind"] == "cleaned"

    private = await api.post(path, json={"visibility": "private"}, headers=h)
    assert private.status_code == 201, private.text

    listed = await api.get(path, headers=h)
    assert listed.status_code == 200, listed.text
    links = listed.json()
    assert [link["slug"] for link in links] == [active.json()["slug"], expired.json()["slug"]]
    assert links[0]["created_at"] > links[1]["created_at"]
    assert all(link["kind"] == "cleaned" for link in links)

    other = await _user(api)
    assert (await api.get(path, headers=other)).status_code == 404


async def test_raw_share_works_before_render_and_cleaned_share_waits_for_ready(
    api: httpx.AsyncClient, storage: FakeStorage, published: list[object]
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    path = f"/videos/{video['id']}/shares"

    cleaned = await api.post(path, json={}, headers=h)
    assert cleaned.status_code == 201, cleaned.text
    raw = await api.post(path, json={"kind": "raw"}, headers=h)
    assert raw.status_code == 201, raw.text
    assert raw.json()["kind"] == "raw"
    assert raw.json()["slug"] != cleaned.json()["slug"]
    duplicate_raw = await api.post(path, json={"kind": "raw"}, headers=h)
    assert duplicate_raw.status_code == 200, duplicate_raw.text
    assert duplicate_raw.json()["slug"] == raw.json()["slug"]

    listed = await api.get(path, headers=h)
    assert [link["kind"] for link in listed.json()] == ["raw", "cleaned"]

    public_raw = await api.get(f"/s/{raw.json()['slug']}")
    assert public_raw.status_code == 200, public_raw.text
    assert public_raw.json() == {
        "title": "Demo",
        "playback_url": f"http://fake-play/videos/{video['id']}/raw.webm",
        "poster_url": None,
    }
    assert (await api.get(f"/s/{cleaned.json()['slug']}")).status_code == 404


async def test_raw_share_requires_uploaded_object(api: httpx.AsyncClient, published: list[object]) -> None:
    h = await _user(api)
    created = await api.post("/videos", json={}, headers=h)
    path = f"/videos/{created.json()['video_id']}/shares"

    response = await api.post(path, json={"kind": "raw"}, headers=h)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "raw_not_available"
