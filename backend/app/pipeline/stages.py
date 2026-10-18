"""One app_worker transaction per queued stage. Status moves only through ``app.runs.lifecycle``.

``handle`` returns the events for the caller to publish after commit. A Lost compare-and-set means another
writer moved the run first (cancel, or a duplicate delivery): the stage rolls back and returns no events.

A stage that raises is rolled back, then the run is moved to ``failed`` (retryable) in a fresh
transaction, so a broken stage never leaves a live run blocking its video.

Stages: pre-cpu (queued -> preprocessing -> agent_running), agent (agent_running -> awaiting_review, or
-> approved in auto mode), post-io (approved -> postprocessing -> done).
"""

import dataclasses
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import UUID

from psycopg.types.json import Jsonb

from app.contracts.enums import RunStatus
from app.contracts.events import RunDoneEvent, RunFailedEvent, RunProposalReadyEvent
from app.contracts.pipeline import PreprocessResult, Proposal
from app.pipeline.engines import Engines
from app.runs import lifecycle, review
from app.runs.lifecycle import Event, Lost, RunRef
from app.shared.db import Conn, Queue, worker_tx
from app.shared.storage import GcsStorage

log = logging.getLogger(__name__)

Handler = Callable[[Conn, RunRef, Engines, GcsStorage], Awaitable[list[Event]]]
# queue -> (the status a run must be in for this stage, the stage)
Stage = tuple[RunStatus, Handler]


@dataclass(frozen=True)
class Task:
    """One delivered outbox row. Built by the in-process relay now, by the Cloud Tasks handler in phase 3."""

    task_id: str
    queue: Queue
    run_id: UUID
    workspace_id: UUID


async def handle(task: Task, engines: Engines, storage: GcsStorage) -> list[Event]:
    """Run one stage in one app_worker transaction and return the events to publish after commit."""
    stage = _STAGES.get(task.queue)
    if stage is None:
        log.info("no pipeline stage for queue %s (task %s)", task.queue, task.task_id)
        return []
    expected, handler = stage
    try:
        async with worker_tx(task.workspace_id) as conn:
            run = await lifecycle.load(conn, task.run_id)
            if run is None:
                log.info("run %s not visible to this workspace; task %s dropped", task.run_id, task.task_id)
                return []
            if (
                run.status != expected
            ):  # a replayed or cancelled delivery: the run is not where this stage starts
                log.info(
                    "run %s is %s, not %s; task %s is a no-op", run.id, run.status, expected, task.task_id
                )
                return []
            return await handler(conn, run, engines, storage)
    except Lost as e:
        log.info("run %s lost its compare-and-set (%s); stage exits quietly", task.run_id, e)
        return []
    except Exception as e:
        log.exception("stage %s failed for run %s", task.queue, task.run_id)
        return await _fail(task, e)


# a failed stage rolled back to the status it started from; failed is reachable from all but approved
_VIA = {"approved": "postprocessing"}


async def _fail(task: Task, exc: Exception) -> list[Event]:
    err = RunFailedEvent(stage=task.queue, message=f"{type(exc).__name__}: {exc}"[:500], retryable=True)
    try:
        async with worker_tx(task.workspace_id) as conn:
            run = await lifecycle.load(conn, task.run_id)
            if run is None or run.status in ("done", "failed", "cancelled"):
                return []
            events: list[Event] = []
            if run.status in _VIA:
                events += await lifecycle.advance(conn, run, _VIA[run.status])  # type: ignore[arg-type]
                run = dataclasses.replace(run, status=_VIA[run.status])  # type: ignore[arg-type]
            events += await lifecycle.advance(conn, run, "failed", stage=run.stage, error=err)
            return [*events, ("run.failed", err)]
    except Lost:
        return []  # someone else moved it first


async def _raw_uri(conn: Conn, run: RunRef) -> str:
    cur = await conn.execute("select raw_uri from videos where id = %s", (run.video_id,))
    row = await cur.fetchone()
    if row is None or row["raw_uri"] is None:
        raise RuntimeError(f"video {run.video_id} has no raw upload")
    return str(row["raw_uri"])


async def _preprocess(conn: Conn, run: RunRef, engines: Engines, storage: GcsStorage) -> list[Event]:
    raw_uri = await _raw_uri(conn, run)
    events = await lifecycle.advance(conn, run, "preprocessing", stage="preprocess")
    run = dataclasses.replace(run, status="preprocessing", stage="preprocess")
    pre = await engines.preprocess(run, raw_uri)
    await conn.execute("update runs set pre = %s where id = %s", (Jsonb(pre.model_dump(mode="json")), run.id))
    events += await lifecycle.advance(conn, run, "agent_running", stage="agent")
    return events


async def _pre_result(conn: Conn, run_id: UUID) -> PreprocessResult:
    cur = await conn.execute("select pre from runs where id = %s", (run_id,))
    row = await cur.fetchone()
    if row is None or not row["pre"]:
        raise RuntimeError(f"run {run_id} has no preprocess result")
    return PreprocessResult.model_validate(row["pre"])


async def _agent(conn: Conn, run: RunRef, engines: Engines, storage: GcsStorage) -> list[Event]:
    pre = await _pre_result(conn, run.id)
    out = await engines.propose(run, pre)
    # v1 is idempotent: a replayed agent task re-saves it as a no-op
    await conn.execute(
        "insert into proposals (workspace_id, run_id, version, source, script, edit_plan, seg_contexts,"
        " transcript_ctx, checks) values (%s, %s, 1, 'agent', %s, %s, %s, %s, %s) on conflict do nothing",
        (
            run.workspace_id,
            run.id,
            Jsonb(out.script.model_dump(mode="json")),
            Jsonb(out.edit_plan.model_dump(mode="json")),
            Jsonb([s.model_dump(mode="json") for s in out.seg_contexts]),
            Jsonb(out.transcript_ctx.model_dump(mode="json")),
            Jsonb([c.model_dump(mode="json") for c in out.checks]),
        ),
    )
    flags = list(out.flags)
    await conn.execute("update runs set flags = %s where id = %s", (Jsonb(flags), run.id))
    auto = run.mode == "auto"
    events: list[Event] = [
        ("run.proposal_ready", RunProposalReadyEvent(version=1, flags=flags, auto_approved=auto))
    ]
    if auto:
        events += await lifecycle.advance(conn, run, "approved", stage="approved")
    else:
        events += await lifecycle.advance(conn, run, "awaiting_review", stage="review")
    return events


async def _latest_proposal(conn: Conn, run: RunRef) -> Proposal:
    latest = await review.latest(conn, run)
    if latest is None:
        raise RuntimeError(f"run {run.id} has no proposal to render")
    return latest[1]


async def _postprocess(conn: Conn, run: RunRef, engines: Engines, storage: GcsStorage) -> list[Event]:
    proposal = await _latest_proposal(conn, run)
    events = await lifecycle.advance(conn, run, "postprocessing", stage="render")
    run = dataclasses.replace(run, status="postprocessing", stage="render")
    output_uri = storage.output_uri(run.id, proposal.version)
    await engines.render(run, proposal, output_uri)  # object first ...
    events += await lifecycle.advance(
        conn, run, "done", stage="publish", output_uri=output_uri
    )  # ... then the row
    (url,) = await storage.sign(output_uri)
    if url is None:
        raise RuntimeError(f"output object missing after render: {output_uri}")
    events.append(("run.done", RunDoneEvent(video_id=str(run.video_id), output_uri=url)))
    return events


_STAGES: dict[str, Stage] = {
    "pre-cpu": ("queued", _preprocess),
    "agent": ("agent_running", _agent),
    "post-io": ("approved", _postprocess),
}
