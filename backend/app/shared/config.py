"""Runtime settings, read from the environment and backend/.env."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


# Mechanical global limit (phase 2 decision): not an env setting, so a deployment cannot drift.
MAX_RECORDING_SECONDS = 900

# Keep this provider catalog as plain data so shared configuration does not depend on API schemas.
VOICES: tuple[dict[str, str], ...] = (
    {"id": "coral", "label": "Coral", "hint": "Warm, calm", "sample_path": "/voice-samples/coral.mp3"},
    {"id": "ash", "label": "Ash", "hint": "Clear, steady", "sample_path": "/voice-samples/ash.mp3"},
    {"id": "sage", "label": "Sage", "hint": "Neutral, crisp", "sample_path": "/voice-samples/sage.mp3"},
)


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

    # Model calls. An empty key or an empty Gemma URL fails that call closed.
    openai_api_key: SecretStr = SecretStr("")
    openai_base_url: str = "https://api.openai.com/v1"
    openai_chat_model: str = "gpt-6-luna"
    openai_speech_model: str = "gpt-4o-mini-tts-2025-12-15"
    openai_speech_voice: str = "coral"
    gemma_base_url: str = ""
    gemma_api_key: SecretStr = SecretStr("")
    modal_proxy_token_id: str = ""
    modal_proxy_token_secret: SecretStr = SecretStr("")
    gemma_model: str = "gemma-4"

    @property
    def gemma_bearer_token(self) -> SecretStr:
        if self.gemma_api_key.get_secret_value():
            return self.gemma_api_key
        token_id = self.modal_proxy_token_id.strip()
        token_secret = self.modal_proxy_token_secret.get_secret_value()
        if bool(token_id) != bool(token_secret):
            raise ValueError("set both MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET")
        if token_id:
            return SecretStr(f"{token_id}.{token_secret}")
        return SecretStr("")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]
