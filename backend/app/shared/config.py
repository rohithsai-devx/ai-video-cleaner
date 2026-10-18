"""Runtime settings, read from the environment and backend/.env."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


# Mechanical global limit (phase 2 decision): not an env setting, so a deployment cannot drift.
MAX_RECORDING_SECONDS = 900


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    # The API connects only as app_api; the pool refuses any other role.
    database_url_api: str
    db_pool_min_size: int = Field(default=1, ge=0)
    db_pool_max_size: int = Field(default=10, ge=1)

    jwt_secret: SecretStr = Field(min_length=16)  # use 32+ bytes outside local dev
    jwt_ttl_seconds: int = Field(default=1800, ge=60)

    # Local fake worker only (phase 1): the outbox relay and the worker each use their own role.
    database_url_worker: str | None = None
    database_url_relay: str | None = None
    fake_worker: bool = False

    redis_url: str = "redis://localhost:6379/0"
    storage_emulator_host: str | None = None
    gcs_bucket: str = "avc-local"

    frontend_base_url: str = "http://localhost:3000"  # share links point here


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
