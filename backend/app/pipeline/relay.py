"""The delivery seam: claim unsent outbox rows as app_relay and hand each task to ``stages.handle``.

``claim`` takes a session advisory lock per row and leaves ``sent_at`` null. ``run_in_process`` holds
those locks across ``handle``, then sets ``sent_at`` and unlocks. A killed process drops the lock with
``sent_at`` still null, so the next poll redelivers. ``handle`` is idempotent from the in-progress status.

``run_in_process`` is the local stand-in for Cloud Tasks. Phase 4 adds the Cloud Tasks client and the HTTP
handler that calls the same ``handle`` for each delivered task. See docs/design/phase3a-architecture.md.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Any

from app.pipeline.engines import Engines
from app.pipeline.stages import Task, handle
from app.shared.config import get_settings
from app.shared.db import Conn, connect_as
from app.shared.db.pool import RELAY_ROLE
from app.shared.events import publish_all
from app.shared.storage import GcsStorage

log = logging.getLogger(__name__)

_POLL_S = 0.1
_CLAIM_BATCH = 10


def _payload_attempt(payload: dict[str, Any]) -> int:
    """Pre-D1 outbox rows have no attempt field and represent their initial attempt."""
    return int(payload.get("attempt", 1))


@dataclass(frozen=True)
class _Held:
    """An unsent outbox row locked on the relay connection. ``sent_at`` is still null."""

    outbox_id: int
    task: Task


async def claim(relay: Conn, limit: int, queues: tuple[str, ...] | None = None) -> list[_Held]:
    """Lock unsent rows on this connection. Do not set ``sent_at``; the caller does that after handle.

    ``queues`` limits which notes this process takes. None takes every queue. The Mac agent and the
    Docker ffmpeg worker pass different queues so they do not take each other's jobs.
    """
    if queues is not None and len(queues) == 0:
        return []
    sql = "select id, workspace_id, run_id, queue, task_id, payload from outbox where sent_at is null"
    params: list[object] = []
    if queues is not None:
        sql += " and queue = any(%s)"
        params.append(list(queues))
    sql += " order by id limit %s for update skip locked"
    params.append(limit)
    async with relay.transaction():
        cur = await relay.execute(sql, params)
        rows = await cur.fetchall()
        held: list[_Held] = []
        for r in rows:
            locked = await relay.execute("select pg_try_advisory_lock(%s::bigint) as locked", (r["id"],))
            got = await locked.fetchone()
            if got is None or not got["locked"]:
                continue  # another session holds it; leave the row unsent
            held.append(
                _Held(
                    outbox_id=r["id"],
                    task=Task(
                        task_id=r["task_id"],
                        queue=r["queue"],
                        run_id=r["run_id"],
                        workspace_id=r["workspace_id"],
                        attempt=_payload_attempt(r["payload"]),
                    ),
                )
            )
    return held


async def _mark_sent(relay: Conn, outbox_id: int) -> None:
    await relay.execute("update outbox set sent_at = now(), tries = tries + 1 where id = %s", (outbox_id,))


async def _unlock(relay: Conn, outbox_id: int) -> None:
    cur = await relay.execute("select pg_advisory_unlock(%s::bigint)", (outbox_id,))
    await cur.fetchone()


async def run_in_process(
    stop: asyncio.Event,
    engines: Engines,
    storage: GcsStorage,
    queues: tuple[str, ...] | None = None,
) -> None:
    """Drain the outbox until ``stop`` is set. The worker pool must already be open (db.open_worker_pool).

    ``queues`` is the same filter as ``claim``. None drains every queue.
    """
    url = get_settings().database_url_relay
    if not url:
        raise RuntimeError("the in-process relay needs DATABASE_URL_RELAY")
    relay = await connect_as(url, RELAY_ROLE)
    try:
        while not stop.is_set():
            held = await claim(relay, _CLAIM_BATCH, queues)
            for item in held:
                try:
                    # stage failures already mark the run failed; this only guards the loop (e.g. DB down)
                    events = await handle(item.task, engines, storage)
                except Exception:
                    log.exception("task %s (%s) could not be handled", item.task.task_id, item.task.queue)
                    await _unlock(relay, item.outbox_id)  # sent_at stays null, so a later poll redelivers
                    continue
                try:
                    await _mark_sent(relay, item.outbox_id)
                finally:
                    await _unlock(relay, item.outbox_id)
                await publish_all(item.task.run_id, events)  # after commit; best effort
            if not held:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), _POLL_S)
    finally:
        await relay.close()


__all__ = ["Task", "claim", "run_in_process"]
