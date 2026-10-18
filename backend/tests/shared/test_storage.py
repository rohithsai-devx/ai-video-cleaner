import uuid

import httpx
import pytest

from app.shared.storage import GcsStorage
from app.shared.storage import gcs as gcs_module

EMULATOR = "http://localhost:4443"  # same form as STORAGE_EMULATOR_HOST in .env


async def _put(url: str, payload: bytes) -> httpx.Response:
    async with httpx.AsyncClient() as c:
        return await c.put(url, content=payload, headers={"Content-Type": "video/webm"})


async def _get(url: str) -> httpx.Response:
    async with httpx.AsyncClient() as c:
        return await c.get(url)


@pytest.fixture(params=[EMULATOR, "localhost:4443"], ids=["with-scheme", "bare"])
def storage(request: pytest.FixtureRequest) -> GcsStorage:
    s = GcsStorage(bucket=f"avc-test-{uuid.uuid4().hex[:12]}", emulator_host=request.param)
    s.client.create_bucket(s.bucket_name)
    return s


def test_layout_uris(storage: GcsStorage):
    video_id = uuid.uuid4()
    run_id = uuid.uuid4()
    assert storage.raw_uri(video_id) == f"gs://{storage.bucket_name}/videos/{video_id}/raw.webm"
    assert storage.output_uri(run_id, 2) == f"gs://{storage.bucket_name}/runs/{run_id}/post/v2/final.mp4"


@pytest.mark.asyncio
async def test_upload_exists_and_sign(storage: GcsStorage):
    uri = storage.raw_uri(uuid.uuid4())
    payload = b"fake-media-bytes" * 100
    assert await storage.exists(uri) is False

    session_url = await storage.upload_session(uri, content_type="video/webm")
    resp = await _put(session_url, payload)
    assert resp.status_code in (200, 201), resp.text

    assert await storage.exists(uri) is True
    (url,) = await storage.sign(uri)
    assert url is not None
    got = await _get(url)
    assert got.status_code == 200
    assert got.content == payload


@pytest.mark.asyncio
async def test_sign_is_none_for_none_missing_and_foreign_bucket(storage: GcsStorage):
    missing = storage.output_uri(uuid.uuid4(), 1)
    foreign = "gs://some-other-bucket/videos/x/raw.webm"
    assert await storage.sign(None, missing, foreign) == [None, None, None]
    assert await storage.exists(foreign) is False


@pytest.mark.asyncio
async def test_copy_within_bucket(storage: GcsStorage):
    src = storage.raw_uri(uuid.uuid4())
    dst = storage.output_uri(uuid.uuid4(), 1)
    session_url = await storage.upload_session(src, content_type="video/webm")
    assert (await _put(session_url, b"abc")).status_code in (200, 201)

    await storage.copy(src, dst)

    assert await storage.exists(dst) is True


@pytest.mark.asyncio
async def test_sign_missing_object_is_none_not_raise(storage: GcsStorage):
    # a missing object signs to None (the API omits the URL); the NotFound never escapes
    assert await storage.sign(storage.raw_uri(uuid.uuid4())) == [None]


@pytest.mark.asyncio
async def test_put_then_sign_reads_back(storage: GcsStorage):
    uri = storage.raw_uri(uuid.uuid4())
    await storage.put(uri, b"seeded", "video/webm")
    assert await storage.exists(uri) is True
    (url,) = await storage.sign(uri)
    assert url is not None and (await _get(url)).content == b"seeded"
    with pytest.raises(ValueError):
        await storage.put("gs://someone-else/x", b"x", "video/webm")


def test_upload_session_sends_the_frontend_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    def fake(self: object, **kwargs: object) -> str:
        seen.update(kwargs)
        return "http://session"

    monkeypatch.setattr(gcs_module.storage.Blob, "create_resumable_upload_session", fake)
    s = GcsStorage(bucket="b", emulator_host="localhost:4443", origin="http://app.example")
    assert s._upload_session("videos/x/raw.webm", "video/webm") == "http://session"
    assert seen == {"content_type": "video/webm", "origin": "http://app.example"}
