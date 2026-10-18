"""The delivery seam: claim unsent outbox rows as app_relay and hand each task to ``stages.handle``.

``run_in_process`` is the local stand-in for Cloud Tasks. Phase 3 adds an HTTP handler that calls the same
``handle`` for each delivered task.
"""

import asyncio
import contextlib
import logging

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


async def claim(relay: Conn, limit: int) -> list[Task]:
    """Take unsent outbox rows and mark them sent in one transaction (FOR UPDATE SKIP LOCKED)."""
    async with relay.transaction():
        cur = await relay.execute(
            "select id, workspace_id, run_id, queue, task_id from outbox where sent_at is null"
            " order by id limit %s for update skip locked",
            (limit,),
        )
        rows = await cur.fetchall()
        if rows:
            await relay.execute(
                "update outbox set sent_at = now(), tries = tries + 1 where id = any(%s)",
                ([r["id"] for r in rows],),
            )
    return [
        Task(task_id=r["task_id"], queue=r["queue"], run_id=r["run_id"], workspace_id=r["workspace_id"])
        for r in rows
    ]


async def run_in_process(stop: asyncio.Event, engines: Engines, storage: GcsStorage) -> None:
    """Drain the outbox until ``stop`` is set. The worker pool must already be open (db.open_worker_pool)."""
    url = get_settings().database_url_relay
    if not url:
        raise RuntimeError("the in-process relay needs DATABASE_URL_RELAY")
    relay = await connect_as(url, RELAY_ROLE)
    try:
        while not stop.is_set():
            tasks = await claim(relay, _CLAIM_BATCH)
            for task in tasks:
                try:
                    # stage failures already mark the run failed; this only guards the loop (e.g. DB down)
                    events = await handle(task, engines, storage)
                except Exception:
                    log.exception("task %s (%s) could not be handled", task.task_id, task.queue)
                    continue
                await publish_all(task.run_id, events)  # after commit; best effort
            if not tasks:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), _POLL_S)
    finally:
        await relay.close()


__all__ = ["Task", "claim", "run_in_process"]
