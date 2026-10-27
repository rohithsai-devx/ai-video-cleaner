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
