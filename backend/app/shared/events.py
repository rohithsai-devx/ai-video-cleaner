"""Redis pub/sub for run events. Publish only after the transaction that caused the event commits."""

import json
import logging
from uuid import UUID

import redis.asyncio as aioredis
from pydantic import BaseModel

from app.shared.config import get_settings

log = logging.getLogger(__name__)

Event = tuple[str, BaseModel]  # (SSE event name, payload); publish after commit

_redis: aioredis.Redis | None = None


def channel(run_id: UUID | str) -> str:
    return f"run:{run_id}"


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.Redis.from_url(get_settings().redis_url)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


def encode(event: str, data: BaseModel) -> str:
    return json.dumps({"event": event, "data": data.model_dump(mode="json")})


async def publish(run_id: UUID | str, event: str, data: BaseModel) -> None:
    """Best effort: a client that reconnects refetches status, so a lost event is not fatal."""
    try:
        await get_redis().publish(channel(run_id), encode(event, data))
    except Exception:  # noqa: BLE001 - events are best-effort by design
        log.warning("publish %s for run %s failed", event, run_id, exc_info=True)


async def publish_all(run_id: UUID | str, events: list[Event]) -> None:
    """Publish in order after commit. Best effort: publish() swallows failures, so this never raises."""
    for name, payload in events:
        await publish(run_id, name, payload)
