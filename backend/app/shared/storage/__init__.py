"""Object storage: the GCS client, its settings-driven factory, and the StorageDep router dependency."""

from functools import lru_cache
from typing import Annotated

from fastapi import Depends

from app.shared.config import get_settings
from app.shared.storage.gcs import GcsStorage


@lru_cache
def get_storage() -> GcsStorage:
    s = get_settings()
    return GcsStorage(s.gcs_bucket, s.storage_emulator_host, origin=s.frontend_base_url)


# Media bytes never pass through the API.
StorageDep = Annotated[GcsStorage, Depends(get_storage)]

__all__ = ["GcsStorage", "StorageDep", "get_storage"]
