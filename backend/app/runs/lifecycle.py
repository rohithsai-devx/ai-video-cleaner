"""The only code that changes runs.status.

Every move is one compare-and-set, plus what entering the new status carries. Callers hold a
transaction (tenant_tx for the API, worker_tx for workers) and publish the returned events after commit.
"""

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Final, LiteralString
from uuid import UUID

from psycopg import errors, sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contracts.enums import RunMode, RunStatus, VoiceMode
from app.contracts.events import RunFailedEvent, RunStatusEvent
from app.contracts.pipeline import FixOptions
from app.runs.exceptions import LiveRunExists as LiveRunExists
from app.runs.exceptions import Lost as Lost
from app.runs.exceptions import RunNotCurrent as RunNotCurrent
from app.runs.exceptions import RunNotFailed as RunNotFailed
from app.runs.exceptions import RunNotRetryable as RunNotRetryable
from app.runs.exceptions import VideoNotFound as VideoNotFound
from app.runs.exceptions import VideoNotStartable as VideoNotStartable
from app.runs.schemas import Run, RunListItem
from app.shared.db import Conn, Queue, enqueue
from app.shared.events import Event


async def _one(conn: Conn, query: LiteralString, params: Sequence[Any]) -> dict[str, Any] | None:
    """fetchone as a dict, whatever the connection's row factory (worker and API connections differ)."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(query, params)
        return await cur.fetchone()


_FINISHED = ("done", "failed", "cancelled")

# Video columns set when a run enters a status; always guarded by current_run_id.
_VIDEO_SET: dict[str, LiteralString] = {
    "awaiting_review": "status = 'awaiting_review'::video_status",
    "approved": "status = 'rendering'::video_status",
    "done": "status = 'ready'::video_status, output_uri = %(output_uri)s",
    "failed": "status = 'failed'::video_status",
    "cancelled": (
        "status = case when output_uri is not null then 'ready'::video_status"
        " else 'uploaded'::video_status end"
    ),
}

# Outbox rows written in the same transaction as the status change.
_ENQUEUE: dict[str, tuple[Queue, str]] = {
    "agent_running": ("agent", "agent"),
    "approved": ("post-io", "post-io"),
}


@dataclass(frozen=True)
class RunRef:
    id: UUID
    workspace_id: UUID
    video_id: UUID
    status: RunStatus
    stage: str | None
    attempt: int
    mode: RunMode
    duration_s: float | None  # video duration, else runs.pre.duration
    error: RunFailedEvent | None = None


_REF_SQL: Final = (
    "select r.id, r.workspace_id, r.video_id, r.status, r.stage, r.attempt, r.mode, r.pre, r.error,"
    " v.duration_s as video_duration_s from runs r join videos v on v.id = r.video_id where r.id = %s"
)


def _ref(row: dict[str, Any]) -> RunRef:
    if row["video_duration_s"] is not None:
        duration: float | None = float(row["video_duration_s"])
    else:
        pre_duration = (row["pre"] or {}).get("duration")
        duration = float(pre_duration) if pre_duration is not None else None
    return RunRef(
        id=row["id"],
        workspace_id=row["workspace_id"],
        video_id=row["video_id"],
        status=row["status"],
        stage=row["stage"],
        attempt=row["attempt"],
        mode=row["mode"],
        duration_s=duration,
        error=RunFailedEvent.model_validate(row["error"]) if row["error"] else None,
    )


def _to_run(row: dict[str, Any]) -> Run:
    return Run(
        id=str(row["id"]),
        video_id=str(row["video_id"]),
        mode=row["mode"],
        voice=row["voice"],
        voice_id=row["voice_id"],
        fix_options=FixOptions.model_validate(row["fix_options"] or {}),
        status=row["status"],
        stage=row["stage"],
        attempt=row["attempt"],
        flags=list(row["flags"] or []),
        error=RunFailedEvent.model_validate(row["error"]) if row["error"] else None,
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


async def load(conn: Conn, run_id: UUID, *, for_update: bool = True) -> RunRef | None:
    """None means invisible (RLS) or missing. for_update locks the run row for read-then-write."""
    query = _REF_SQL + (" for update of r" if for_update else "")
    row = await _one(conn, query, (run_id,))
    return None if row is None else _ref(row)


async def get(conn: Conn, run_id: UUID) -> Run | None:
    row = await _one(conn, "select * from runs where id = %s", (run_id,))
    return None if row is None else _to_run(row)


async def list_for_video(conn: Conn, video_id: UUID) -> list[RunListItem]:
    """Return a video's latest 20 attempts; visibility of the video is checked by the caller."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "select id, status, created_at, voice, voice_id from runs"
            " where video_id = %s order by created_at desc limit 20",
            (video_id,),
        )
        rows = await cur.fetchall()
    return [
        RunListItem(
            run_id=str(row["id"]),
            status=row["status"],
            created_at=row["created_at"],
            voice=row["voice"],
            voice_id=row["voice_id"],
        )
        for row in rows
    ]


async def start(
    conn: Conn,
    *,
    video_id: UUID,
    mode: RunMode,
    voice: VoiceMode,
    voice_id: str | None,
    fix_options: FixOptions | None = None,
) -> tuple[RunRef, list[Event]]:
    """Insert a queued run, point the video at it, and enqueue pre-cpu."""
    video = await _one(
        conn,
        "select id, workspace_id, status, raw_uri, duration_s from videos where id = %s for update",
        (video_id,),
    )
    if video is None:
        raise VideoNotFound()
    if video["raw_uri"] is None or video["status"] not in ("uploaded", "ready", "failed"):
        raise VideoNotStartable(video["status"])
    try:
        row = await _one(
            conn,
            "insert into runs (workspace_id, video_id, created_by, mode, voice, voice_id, fix_options)"
            " values (%s, %s, app.uid(), %s, %s, %s, %s) returning id, attempt",
            (
                video["workspace_id"],
                video_id,
                mode,
                voice,
                voice_id,
                Jsonb((fix_options or FixOptions()).model_dump(mode="json")),
            ),
        )
    except errors.UniqueViolation as e:
        if e.diag.constraint_name != "runs_one_live_per_video":
            raise
        raise LiveRunExists() from None
    assert row is not None
    await conn.execute(
        "update videos set current_run_id = %s, status = 'processing' where id = %s", (row["id"], video_id)
    )
    await enqueue(
        conn,
        workspace_id=video["workspace_id"],
        run_id=row["id"],
        queue="pre-cpu",
        stage="pre-cpu",
        attempt=row["attempt"],
        payload={"run_id": str(row["id"]), "video_id": str(video_id), "attempt": row["attempt"]},
    )
    duration = float(video["duration_s"]) if video["duration_s"] is not None else None
    ref = RunRef(
        id=row["id"],
        workspace_id=video["workspace_id"],
        video_id=video_id,
        status="queued",
        stage=None,
        attempt=row["attempt"],
        mode=mode,
        duration_s=duration,
    )
    return ref, [("run.status", RunStatusEvent(status="queued"))]


async def advance(
    conn: Conn,
    run: RunRef,
    to: RunStatus,
    *,
    stage: str | None = None,
    error: RunFailedEvent | None = None,
    output_uri: str | None = None,
    retry: bool = False,
) -> list[Event]:
    """Move run.status to ``to`` and do what entering ``to`` requires. Raises Lost on 0 rows."""
    if to == "done" and not output_uri:
        raise ValueError("a done run needs its output_uri")
    if to == "failed" and error is None:
        raise ValueError("a failed run needs its error")
    params: dict[str, Any] = {"id": run.id, "expected": run.status, "to": to}
    run_sets: list[sql.Composable] = [sql.SQL("status = %(to)s")]
    if stage is not None:
        run_sets.append(sql.SQL("stage = %(stage)s"))
        params["stage"] = stage
    if error is not None:
        run_sets.append(sql.SQL("error = %(error)s"))
        params["error"] = Jsonb(error.model_dump(mode="json"))
    if retry:
        run_sets.extend(
            [sql.SQL("attempt = %(attempt)s"), sql.SQL("finished_at = null"), sql.SQL("error = null")]
        )
        params["attempt"] = run.attempt
    if to == "preprocessing":
        run_sets.append(sql.SQL("started_at = coalesce(started_at, now())"))
    if to in _FINISHED:
        run_sets.append(sql.SQL("finished_at = %(finished_at)s"))
        params["finished_at"] = datetime.now(UTC)
    cur = await conn.execute(
        sql.SQL("update runs set {} where id = %(id)s and status = %(expected)s").format(
            sql.SQL(", ").join(run_sets)
        ),
        params,
    )
    if cur.rowcount != 1:
        raise Lost(f"run {run.id} moved on from {run.status}")

    video_set = _VIDEO_SET.get(to)
    if video_set is not None:
        video_params: dict[str, Any] = {"video_id": run.video_id, "run_id": run.id}
        if to == "done":
            video_params["output_uri"] = output_uri
        await conn.execute(
            sql.SQL("update videos set {} where id = %(video_id)s and current_run_id = %(run_id)s").format(
                sql.SQL(video_set)
            ),
            video_params,
        )

    if to in _ENQUEUE:
        queue, stage_name = _ENQUEUE[to]
        await enqueue(
            conn,
            workspace_id=run.workspace_id,
            run_id=run.id,
            queue=queue,
            stage=stage_name,
            attempt=run.attempt,
            payload={"run_id": str(run.id), "attempt": run.attempt},
        )
    return [("run.status", RunStatusEvent(status=to, stage=stage if stage is not None else run.stage))]


async def retry(conn: Conn, run_id: UUID) -> tuple[RunRef, list[Event]] | None:
    """Restart a failed current run at the failed stage's entry point, with one new attempt."""
    run = await load(conn, run_id)
    if run is None:
        return None
    if run.status != "failed":
        raise RunNotFailed("run is not failed")
    if run.error is not None and not run.error.retryable:
        raise RunNotRetryable("run failure is not retryable")

    video = await _one(
        conn,
        "select current_run_id from videos where id = %s for update",
        (run.video_id,),
    )
    if video is None or video["current_run_id"] != run.id:
        raise RunNotCurrent("run is not the video's current run")

    if run.stage is None or run.stage == "preprocess":
        target, target_stage, video_status = "preprocessing", "preprocess", "processing"
    elif run.stage == "agent":
        target, target_stage, video_status = "agent_running", "agent", "processing"
    elif run.stage in ("approved", "render"):
        target, target_stage, video_status = "postprocessing", "render", "rendering"
    else:
        raise RunNotRetryable("run stage cannot be retried")

    bumped = replace(run, attempt=run.attempt + 1)
    events = await advance(conn, bumped, target, stage=target_stage, retry=True)
    cur = await conn.execute(
        "update videos set status = %s::video_status where id = %s and current_run_id = %s",
        (video_status, run.video_id, run.id),
    )
    if cur.rowcount != 1:
        raise Lost(f"video {run.video_id} changed current run during retry")

    if target == "preprocessing":
        await enqueue(
            conn,
            workspace_id=run.workspace_id,
            run_id=run.id,
            queue="pre-cpu",
            stage="pre-cpu",
            attempt=bumped.attempt,
            payload={"run_id": str(run.id), "video_id": str(run.video_id), "attempt": bumped.attempt},
        )
    elif target == "postprocessing":
        await enqueue(
            conn,
            workspace_id=run.workspace_id,
            run_id=run.id,
            queue="post-io",
            stage="post-io",
            attempt=bumped.attempt,
            payload={"run_id": str(run.id), "attempt": bumped.attempt},
        )

    current = replace(bumped, status=target, stage=target_stage, error=None)
    return current, events
