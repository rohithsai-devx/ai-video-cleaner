"""Queue enqueues as outbox rows, written in the caller's transaction alongside the state change."""

import hashlib
from typing import Any, Literal
from uuid import UUID

from psycopg.types.json import Jsonb

from app.shared.db.pool import Conn

Queue = Literal["pre-cpu", "pre-io", "agent", "post-io", "post-cpu"]


def task_id(run_id: UUID, stage: str, attempt: int) -> str:
    """sha256(run_id:stage:attempt), also the Cloud Tasks task id."""
    return hashlib.sha256(f"{run_id}:{stage}:{attempt}".encode()).hexdigest()


async def enqueue(
    conn: Conn,
    *,
    workspace_id: UUID,
    run_id: UUID,
    queue: Queue,
    stage: str,
    attempt: int,
    payload: dict[str, Any],
) -> str:
    """Insert the outbox row (idempotent on task_id) and return the task id."""
    tid = task_id(run_id, stage, attempt)
    await conn.execute(
        "insert into outbox (workspace_id, run_id, queue, task_id, payload)"
        " values (%s, %s, %s, %s, %s) on conflict do nothing",
        (workspace_id, run_id, queue, tid, Jsonb(payload)),
    )
    return tid
