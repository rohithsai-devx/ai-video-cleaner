"""Status moves only through ``app.runs.lifecycle``.

``handle`` returns the events to publish after the last commit. A Lost compare-and-set means another
writer moved the run first (cancel, or a duplicate delivery): the stage returns no events.

The agent stage is one transaction. pre-cpu and post-io are three beats so the engine runs with no
connection held: commit the in-progress status, run the engine, commit the result. A redelivery that
finds the run already preprocessing or postprocessing runs the engine again and overwrites the result.
Any other status returns no events and does not call the engine.

A stage that raises is moved to ``failed`` (retryable) in a fresh transaction. ``approved`` has no
edge to ``failed``, so that failure goes through ``postprocessing`` first.

Stages: pre-cpu (queued -> preprocessing -> agent_running), agent (agent_running -> approved only when
the run is auto and the proposal was accepted, otherwise awaiting_review), post-io
(approved -> postprocessing -> done).
"""

import dataclasses
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import UUID

from psycopg.types.json import Jsonb

from app.contracts.enums import RunStatus, VoiceMode
from app.contracts.events import RunDoneEvent, RunFailedEvent, RunProposalReadyEvent
from app.contracts.pipeline import FixOptions, PreprocessResult, Proposal
from app.pipeline.engines import Engines
from app.runs import lifecycle, review
from app.runs.lifecycle import Event, Lost, RunRef
from app.shared.db import Conn, Queue, worker_tx
from app.shared.storage import GcsStorage

log = logging.getLogger(__name__)

Handler = Callable[[Conn, RunRef, Engines, GcsStorage], Awaitable[list[Event]]]


@dataclass(frozen=True)
class Task:
    """One delivered outbox row. Built by the in-process relay now, by the Cloud Tasks handler in phase 3."""

    task_id: str
    queue: Queue
    run_id: UUID
    workspace_id: UUID
    attempt: int


async def handle(task: Task, engines: Engines, storage: GcsStorage) -> list[Event]:
    """Run one stage and return the events to publish after the last commit."""
    try:
        if task.queue == "pre-cpu":
            return await _preprocess(task, engines)
        if task.queue == "post-io":
            return await _postprocess(task, engines, storage)
        if task.queue == "agent":
            return await _one_tx(task, "agent_running", _agent, engines, storage)
        log.info("no pipeline stage for queue %s (task %s)", task.queue, task.task_id)
        return []
    except Lost as e:
        log.info("run %s lost its compare-and-set (%s); stage exits quietly", task.run_id, e)
        return []
    except Exception as e:
        log.exception("stage %s failed for run %s", task.queue, task.run_id)
        return await _fail(task, e)


async def _one_tx(
    task: Task, expected: RunStatus, handler: Handler, engines: Engines, storage: GcsStorage
) -> list[Event]:
    """The agent stage: one app_worker transaction around the whole handler."""
    async with worker_tx(task.workspace_id) as conn:
        run = await _gate(conn, task, expected, expected)
        if run is None:
            return []
        return await handler(conn, run, engines, storage)


async def _gate(conn: Conn, task: Task, start: RunStatus, busy: RunStatus) -> RunRef | None:
    """The run when this stage should continue. None: drop the task, do not call the engine."""
    run = await lifecycle.load(conn, task.run_id)
    if run is None:
        log.info("run %s not visible to this workspace; task %s dropped", task.run_id, task.task_id)
        return None
    if task.attempt != run.attempt:
        log.info(
            "run %s is on attempt %s, not task attempt %s; task %s is a no-op",
            run.id,
            run.attempt,
            task.attempt,
            task.task_id,
        )
        return None
    if run.status != start and run.status != busy:
        log.info("run %s is %s, not %s; task %s is a no-op", run.id, run.status, start, task.task_id)
        return None
    return run


async def _still(conn: Conn, task: Task, busy: RunStatus) -> RunRef | None:
    """The run still in the engine's status. None: it moved (cancelled) while the engine ran."""
    run = await lifecycle.load(conn, task.run_id)
    if run is None or run.attempt != task.attempt or run.status != busy:
        log.info(
            "run %s is attempt %s status %s after the engine; task attempt %s is a no-op",
            task.run_id,
            run.attempt if run is not None else "gone",
            run.status if run is not None else "gone",
            task.attempt,
            task.task_id,
        )
        return None
    return run


# a failed stage rolled back to the status it started from; failed is reachable from all but approved
_VIA = {"approved": "postprocessing"}


async def _fail(task: Task, exc: Exception) -> list[Event]:
    err = RunFailedEvent(stage=task.queue, message=f"{type(exc).__name__}: {exc}"[:500], retryable=True)
    try:
        async with worker_tx(task.workspace_id) as conn:
            run = await lifecycle.load(conn, task.run_id)
            if run is None or run.status in ("done", "failed", "cancelled"):
                return []
            if run.attempt != task.attempt:
                log.info(
                    "run %s is on attempt %s, not failing task attempt %s; stale failure dropped",
                    run.id,
                    run.attempt,
                    task.attempt,
                )
                return []
            events: list[Event] = []
            if run.status in _VIA:
                events += await lifecycle.advance(conn, run, _VIA[run.status])  # type: ignore[arg-type]
                run = dataclasses.replace(run, status=_VIA[run.status])  # type: ignore[arg-type]
            events += await lifecycle.advance(conn, run, "failed", stage=run.stage, error=err)
            return [*events, ("run.failed", err)]
    except Lost:
        return []  # someone else moved it first


async def _voice(conn: Conn, run_id: UUID) -> VoiceMode:
    cur = await conn.execute("select voice from runs where id = %s", (run_id,))
    row = await cur.fetchone()
    if row is None:
        raise RuntimeError(f"run {run_id} has no voice")
    voice: VoiceMode = row["voice"]
    return voice


async def _fix_options(conn: Conn, run_id: UUID) -> FixOptions:
    cur = await conn.execute("select fix_options from runs where id = %s", (run_id,))
    row = await cur.fetchone()
    if row is None:
        raise RuntimeError(f"run {run_id} has no fix options")
    return FixOptions.model_validate(row["fix_options"] or {})


async def _raw_uri(conn: Conn, run: RunRef) -> str:
    cur = await conn.execute("select raw_uri from videos where id = %s", (run.video_id,))
    row = await cur.fetchone()
    if row is None or row["raw_uri"] is None:
        raise RuntimeError(f"video {run.video_id} has no raw upload")
    return str(row["raw_uri"])


async def _preprocess(task: Task, engines: Engines) -> list[Event]:
    async with worker_tx(task.workspace_id) as conn:
        run = await _gate(conn, task, "queued", "preprocessing")
        if run is None:
            return []
        raw_uri = await _raw_uri(conn, run)
        events: list[Event] = []
        if run.status == "queued":
            events = await lifecycle.advance(conn, run, "preprocessing", stage="preprocess")
            run = dataclasses.replace(run, status="preprocessing", stage="preprocess")
    # Beat 2. The status commit has landed, so ffmpeg holds no run-row lock and no connection.
    pre = await engines.preprocess(run, raw_uri)
    async with worker_tx(task.workspace_id) as conn:
        run = await _still(conn, task, "preprocessing")
        if run is None:
            return []
        await conn.execute(
            "update runs set pre = %s where id = %s", (Jsonb(pre.model_dump(mode="json")), run.id)
        )
        await conn.execute("update videos set duration_s = %s where id = %s", (pre.duration, run.video_id))
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
    voice = await _voice(conn, run.id)
    fix_options = await _fix_options(conn, run.id)
    out = await engines.propose(run, pre, voice=voice, fix_options=fix_options)
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
    approved = run.mode == "auto" and out.accepted
    events: list[Event] = [
        ("run.proposal_ready", RunProposalReadyEvent(version=1, flags=flags, auto_approved=approved))
    ]
    if approved:
        events += await lifecycle.advance(conn, run, "approved", stage="approved")
    else:
        events += await lifecycle.advance(conn, run, "awaiting_review", stage="review")
    return events


async def _latest_proposal(conn: Conn, run: RunRef) -> Proposal:
    latest = await review.latest(conn, run)
    if latest is None:
        raise RuntimeError(f"run {run.id} has no proposal to render")
    return latest[1]


async def _postprocess(task: Task, engines: Engines, storage: GcsStorage) -> list[Event]:
    async with worker_tx(task.workspace_id) as conn:
        run = await _gate(conn, task, "approved", "postprocessing")
        if run is None:
            return []
        proposal = await _latest_proposal(conn, run)
        voice = await _voice(conn, run.id)
        events: list[Event] = []
        if run.status == "approved":
            events = await lifecycle.advance(conn, run, "postprocessing", stage="render")
            run = dataclasses.replace(run, status="postprocessing", stage="render")
    # Beat 2. Same rule as preprocess: render (ffmpeg) runs with no connection held.
    output_uri = storage.output_uri(run.id, proposal.version)
    await engines.render(run, proposal, output_uri, voice=voice)
    async with worker_tx(task.workspace_id) as conn:
        run = await _still(conn, task, "postprocessing")
        if run is None:
            return []
        events += await lifecycle.advance(conn, run, "done", stage="publish", output_uri=output_uri)
        (url,) = await storage.sign(output_uri)
        if url is None:
            raise RuntimeError(f"output object missing after render: {output_uri}")
        events.append(("run.done", RunDoneEvent(video_id=str(run.video_id), output_uri=url)))
    return events
