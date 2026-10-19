"""GCS adapter. The API only hands out URLs; media bytes never pass through it.

Callers see only ``gs://`` URIs (built by the layout methods) and signed read URLs.
Object keys stay inside this module. With ``emulator_host`` set (fake-gcs) it uses
anonymous credentials and plain URLs. With it unset the same code runs against real
GCS using ADC and V4 signed URLs; credentials without a private key (Cloud Run)
sign through IAM.

The sync client runs in ``asyncio.to_thread``; async callers keep these calls
outside ``tenant_tx``. ``download_to`` and ``upload_file`` stream a path, so a long
MP4 is never loaded into memory.
"""

import asyncio
from datetime import timedelta
from os import PathLike, fspath
from urllib.parse import quote
from uuid import UUID

import google.auth
from google.api_core.exceptions import NotFound
from google.auth.credentials import AnonymousCredentials
from google.auth.transport.requests import Request
from google.cloud import storage


class GcsStorage:
    def __init__(
        self,
        bucket: str,
        emulator_host: str | None = None,
        project: str = "avc-local",
        origin: str | None = None,
    ):
        self.bucket_name = bucket
        self.origin = origin  # the browser origin allowed to PUT to upload sessions (CORS)
        # STORAGE_EMULATOR_HOST may or may not carry a scheme
        self.emulator_url = (
            (emulator_host if "://" in emulator_host else f"http://{emulator_host}").rstrip("/")
            if emulator_host
            else None
        )
        if self.emulator_url:
            self._creds = None
            self.client = storage.Client(
                project=project,
                credentials=AnonymousCredentials(),  # type: ignore[no-untyped-call]
                client_options={"api_endpoint": self.emulator_url},
            )
        else:
            self._creds, adc_project = google.auth.default()
            self.client = storage.Client(credentials=self._creds, project=adc_project)

    # --- layout: the only place object keys are built ---------------------------------

    def raw_uri(self, video_id: UUID | str) -> str:
        return self._uri(f"videos/{video_id}/raw.webm")

    def poster_uri(self, video_id: UUID | str) -> str:
        return self._uri(f"videos/{video_id}/poster.jpg")

    def output_uri(self, run_id: UUID | str, version: int) -> str:
        return self._uri(f"runs/{run_id}/post/v{version}/final.mp4")

    def output_poster_uri(self, run_id: UUID | str, version: int) -> str:
        return self._uri(f"runs/{run_id}/post/v{version}/poster.jpg")

    def mezz_uri(self, run_id: UUID | str) -> str:
        return self._uri(f"runs/{run_id}/pre/mezz.mp4")

    def audio_uri(self, run_id: UUID | str) -> str:
        return self._uri(f"runs/{run_id}/pre/audio.wav")

    def frame_uri(self, run_id: UUID | str, frame_id: str) -> str:
        return self._uri(f"runs/{run_id}/pre/frames/{frame_id}.jpg")

    def _uri(self, key: str) -> str:
        return f"gs://{self.bucket_name}/{key}"

    def _own_key(self, uri: str) -> str | None:
        """Object key for a URI in this bucket; None for anything else (foreign bucket, not gs://)."""
        prefix = f"gs://{self.bucket_name}/"
        if not uri.startswith(prefix):
            return None
        return uri.removeprefix(prefix)

    # --- async surface: each call runs the sync client in a thread --------------------

    async def upload_session(self, uri: str, content_type: str) -> str:
        """A session URI the browser PUTs bytes to directly."""
        key = self._own_key(uri)
        if key is None:
            raise ValueError(f"not an object in bucket {self.bucket_name}: {uri}")
        return await asyncio.to_thread(self._upload_session, key, content_type)

    async def exists(self, uri: str) -> bool:
        key = self._own_key(uri)
        if key is None:
            return False
        return await asyncio.to_thread(self._blob(key).exists)

    async def sign(self, *uris: str | None) -> list[str | None]:
        """Signed read URLs, in order; None for None, a missing object, or a foreign bucket."""
        return await asyncio.to_thread(self._sign_all, list(uris))

    async def copy(self, src_uri: str, dst_uri: str) -> None:
        """Copy within this bucket (the fixture render copies the raw object to the output URI)."""
        src, dst = self._own_key(src_uri), self._own_key(dst_uri)
        if src is None or dst is None:
            raise ValueError(f"copy is limited to bucket {self.bucket_name}: {src_uri} -> {dst_uri}")
        await asyncio.to_thread(self._copy, src, dst)

    async def put(self, uri: str, data: bytes, content_type: str) -> None:
        """Write a small object (worker artifacts, test seeding). Large media uses upload_file."""
        key = self._own_key(uri)
        if key is None:
            raise ValueError(f"put is limited to bucket {self.bucket_name}: {uri}")
        await asyncio.to_thread(self._blob(key).upload_from_string, data, content_type=content_type)

    async def download_to(self, uri: str, path: str | PathLike[str]) -> None:
        """Stream an object to a file. The parent directory of ``path`` must exist."""
        key = self._own_key(uri)
        if key is None:
            raise ValueError(f"download is limited to bucket {self.bucket_name}: {uri}")
        await asyncio.to_thread(self._download_to, key, fspath(path))

    def download_bytes(self, uri: str) -> bytes:
        """Read a small object from a worker thread, such as a keyframe for VLM input."""
        key = self._own_key(uri)
        if key is None:
            raise ValueError(f"download is limited to bucket {self.bucket_name}: {uri}")
        return self._blob(key).download_as_bytes()

    async def upload_file(self, uri: str, path: str | PathLike[str], content_type: str) -> None:
        """Stream a file to an object. Does not read the file into memory first."""
        key = self._own_key(uri)
        if key is None:
            raise ValueError(f"upload is limited to bucket {self.bucket_name}: {uri}")
        await asyncio.to_thread(self._upload_file, key, fspath(path), content_type)

    # --- sync internals ----------------------------------------------------------------

    def _blob(self, key: str) -> storage.Blob:
        return self.client.bucket(self.bucket_name).blob(key)

    def _download_to(self, key: str, filename: str) -> None:
        self._blob(key).download_to_filename(filename)

    def _upload_file(self, key: str, filename: str, content_type: str) -> None:
        self._blob(key).upload_from_filename(filename, content_type=content_type)

    def _upload_session(self, key: str, content_type: str) -> str:
        uri = self._blob(key).create_resumable_upload_session(content_type=content_type, origin=self.origin)
        return str(uri)

    def _copy(self, src: str, dst: str) -> None:
        bucket = self.client.bucket(self.bucket_name)
        bucket.copy_blob(bucket.blob(src), bucket, dst)

    def _sign_all(self, uris: list[str | None]) -> list[str | None]:
        out: list[str | None] = []
        for uri in uris:
            key = self._own_key(uri) if uri else None
            if key is None:
                out.append(None)
                continue
            try:
                out.append(self._playback_url(key))
            except NotFound:
                out.append(None)
        return out

    def _playback_url(self, key: str, ttl: timedelta = timedelta(hours=1)) -> str:
        """Time-limited read URL. Raises NotFound if the object is missing."""
        blob = self.client.bucket(self.bucket_name).get_blob(key)
        if blob is None:
            raise NotFound(f"gs://{self.bucket_name}/{key}")
        if self.emulator_url:
            obj = quote(key, safe="")
            return f"{self.emulator_url}/storage/v1/b/{self.bucket_name}/o/{obj}?alt=media"
        # key-file credentials sign locally; token-only ones (Cloud Run) sign via IAM signBlob
        creds = self._creds
        if creds is None or hasattr(creds, "signer"):
            return blob.generate_signed_url(version="v4", expiration=ttl, method="GET")
        if not creds.valid:
            creds.refresh(Request())  # type: ignore[no-untyped-call]
        return blob.generate_signed_url(
            version="v4",
            expiration=ttl,
            method="GET",
            service_account_email=creds.service_account_email,
            access_token=creds.token,
        )
