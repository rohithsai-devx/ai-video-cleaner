"""Run routes: /runs/{id}, proposal review, approve and cancel, the SSE stream, and start_run."""

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sse_starlette import EventSourceResponse

from app.auth import CurrentUser
from app.contracts.enums import VoiceMode
from app.contracts.events import RunEvent, RunStatusEvent
from app.contracts.pipeline import Proposal
from app.runs import lifecycle, review
from app.runs.changes import changes
from app.runs.chapters import chapters
from app.runs.checks import AGENT_ONLY_CHECKS
from app.runs.schemas import (
    ApproveRequest,
    KeyframeThumb,
    ProposalUpdate,
    ProposalView,
    Run,
    RunCreate,
    RunCreated,
    RunListItem,
    RunSummary,
    VoiceList,
    VoiceOption,
)
from app.runs.script_lines import script_lines
from app.shared.config import VOICES, get_settings
from app.shared.db import tenant_tx
from app.shared.errors import not_found
from app.shared.events import channel, get_redis, publish_all
from app.shared.storage import GcsStorage, StorageDep

router = APIRouter()


_TERMINAL = ("done", "failed", "cancelled")


@router.get("/voices", tags=["runs"])
async def list_voices(_: CurrentUser) -> VoiceList:
    return VoiceList(
        default_voice_id=get_settings().openai_speech_voice,
        voices=[VoiceOption.model_validate(voice) for voice in VOICES],
    )


@contextmanager
def _domain_errors() -> Iterator[None]:
    """Map domain exceptions to HTTP. Raised inside tenant_tx, so the transaction rolls back."""
    try:
        yield
    except review.VersionConflict as e:
        raise _conflict("version_conflict", str(e), latest_version=e.latest) from None
    except review.NotReviewable as e:
        raise _conflict("not_awaiting_review", str(e)) from None
    except review.NoProposal as e:
        raise _conflict("no_proposal", str(e)) from None
    except review.EditNotAllowed as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    except review.InvalidEdl as e:  # 422 only when the EDL would break the render
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, e.check.model_dump(mode="json")) from None
    except lifecycle.RunNotFailed:
        raise _conflict("run_not_failed", "run is not failed") from None
    except lifecycle.RunNotCurrent:
        raise _conflict("run_not_current", "run is not the video's current run") from None
    except lifecycle.RunNotRetryable:
        raise _conflict("not_retryable", "run failure cannot be retried") from None
    except lifecycle.Lost:
        raise _conflict("run_changed", "run changed concurrently") from None


def _conflict(code: str, message: str, **extra: object) -> HTTPException:
    """409 whose detail carries a machine-readable code, so clients can tell the conflicts apart."""
    return HTTPException(status.HTTP_409_CONFLICT, {"code": code, "message": message, **extra})


async def _view(
    storage: GcsStorage,
    proposal: Proposal,
    frames: list[review.Keyframe],
    agent_v1: Proposal,
    choices: dict[str, tuple[str, str]],
    voice: VoiceMode,
    peaks_uri: str | None,
) -> ProposalView:
    uris = [*(keyframe.uri for keyframe in frames), *([peaks_uri] if peaks_uri is not None else [])]
    urls = await storage.sign(*uris)  # after commit, in a thread
    thumbs = [
        KeyframeThumb(frame_id=k.frame_id, t=k.t, url=url)
        for k, url in zip(frames, urls[: len(frames)], strict=True)
        if url
    ]
    return ProposalView(
        # agent-only checks are for the agent's own loop; the user cannot act on them
        proposal=proposal.model_copy(
            update={"checks": [c for c in proposal.checks if c.name not in AGENT_ONLY_CHECKS]}
        ),
        keyframes=thumbs,
        changes=changes(agent_v1, proposal),
        spots=[
            spot.model_copy(update={"chosen_fix_id": choice[0], "chosen_by": choice[1]})
            if (choice := choices.get(spot.spot_id)) is not None
            and choice[0] in {fix.fix_id for fix in spot.fixes}
            else spot
            for spot in proposal.spots
        ],
        chapters=chapters(proposal),
        script_lines=script_lines(proposal, voice=voice),
        waveform_url=urls[-1] if peaks_uri is not None else None,
    )


@router.get("/runs/{run_id}", tags=["runs"])
async def get_run(run_id: UUID, user_id: CurrentUser) -> Run:
    async with tenant_tx(user_id) as conn:
        run = await lifecycle.get(conn, run_id)
    if run is None:
        raise not_found("run")
    return run


@router.get("/videos/{video_id}/runs", tags=["videos"])
async def list_video_runs(video_id: UUID, user_id: CurrentUser) -> list[RunListItem]:
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select id from videos where id = %s", (video_id,))
        if await cur.fetchone() is None:
            raise not_found("video")
        return await lifecycle.list_for_video(conn, video_id)


@router.get("/runs/{run_id}/proposal", tags=["runs"])
async def get_proposal(run_id: UUID, user_id: CurrentUser, storage: StorageDep) -> ProposalView:
    async with tenant_tx(user_id) as conn:
        try:
            found = await review.read(conn, run_id)
            agent_v1 = await review.first_version(conn, run_id) if found is not None else None
            choices = await review.chosen_fixes(conn, run_id) if found is not None else {}
            voice = await review.voice_mode(conn, run_id) if found is not None else None
            peaks = await review.peaks_uri(conn, run_id) if found is not None else None
        except review.NoProposal:
            raise not_found("proposal") from None
    if found is None:
        raise not_found("run")
    if agent_v1 is None:
        raise not_found("proposal")
    if voice is None:
        raise not_found("run")
    proposal, frames = found
    return await _view(storage, proposal, frames, agent_v1, choices, voice, peaks)


@router.put("/runs/{run_id}/proposal", tags=["runs"])
async def update_proposal(
    run_id: UUID, body: ProposalUpdate, user_id: CurrentUser, storage: StorageDep
) -> ProposalView:
    async with tenant_tx(user_id) as conn:
        run = await lifecycle.load(conn, run_id)  # locks the run row
        if run is None:
            raise not_found("run")
        with _domain_errors():
            proposal = await review.save_edit(conn, run, body)
        frames = await review.keyframes(conn, run)
        agent_v1 = await review.first_version(conn, run_id)
        choices = await review.chosen_fixes(conn, run_id)
        voice = await review.voice_mode(conn, run_id)
        peaks = await review.peaks_uri(conn, run_id)
    if agent_v1 is None:
        raise not_found("proposal")
    if voice is None:
        raise not_found("run")
    return await _view(storage, proposal, frames, agent_v1, choices, voice, peaks)


@router.post("/runs/{run_id}/approve", status_code=status.HTTP_202_ACCEPTED, tags=["runs"])
async def approve(run_id: UUID, user_id: CurrentUser, body: ApproveRequest | None = None) -> RunSummary:
    async with tenant_tx(user_id) as conn:
        run = await lifecycle.load(conn, run_id)  # locks the run row: read-then-write
        if run is None:
            raise not_found("run")
        with _domain_errors():
            events = await review.approve(conn, run, body.base_version if body else None)
    await publish_all(run.id, events)
    return RunSummary(run_id=str(run.id), status="approved", stage=run.stage)


@router.post("/runs/{run_id}/cancel", status_code=status.HTTP_202_ACCEPTED, tags=["runs"])
async def cancel(run_id: UUID, user_id: CurrentUser) -> RunSummary:
    async with tenant_tx(user_id) as conn:
        run = await lifecycle.load(conn, run_id)
        if run is None:
            raise not_found("run")
        if run.status in (*_TERMINAL, "postprocessing"):
            raise HTTPException(status.HTTP_409_CONFLICT, f"run is {run.status} and cannot be cancelled")
        with _domain_errors():
            events = await lifecycle.advance(conn, run, "cancelled")
    await publish_all(run.id, events)
    return RunSummary(run_id=str(run.id), status="cancelled", stage=run.stage)


@router.post("/runs/{run_id}/retry", status_code=status.HTTP_202_ACCEPTED, tags=["runs"])
async def retry(run_id: UUID, user_id: CurrentUser) -> RunSummary:
    async with tenant_tx(user_id) as conn:
        with _domain_errors():
            result = await lifecycle.retry(conn, run_id)
        if result is None:
            raise not_found("run")
        run, events = result
    await publish_all(run.id, events)
    return RunSummary(run_id=str(run.id), status=run.status, stage=run.stage)


_TERMINAL_STATUS = frozenset({"done", "failed", "cancelled"})
_TERMINAL_EVENTS = frozenset({"run.done", "run.failed"})
# after a terminal run.status, wait this long for its run.done / run.failed (publishing is best effort)
_FINAL_EVENT_GRACE_S = 5.0


async def _snapshot(user_id: UUID, run_id: UUID) -> dict[str, Any] | None:
    """The run's status as the caller's tenant sees it; None when RLS hides it (or it does not exist)."""
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select status, stage from runs where id = %s", (run_id,))
        return await cur.fetchone()


@router.get(
    "/runs/{run_id}/events",
    response_class=EventSourceResponse,
    responses={
        200: {
            "model": RunEvent,  # registers the four payload schemas
            "description": "SSE stream; each event's data is the payload named by the event",
            "content": {"text/event-stream": {"schema": {"$ref": "#/components/schemas/RunEvent"}}},
        },
        404: {"description": "Run not found"},
    },
    tags=["events"],
)
async def run_events(run_id: UUID, user_id: CurrentUser) -> EventSourceResponse:
    if await _snapshot(user_id, run_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")

    async def stream() -> AsyncIterator[dict[str, str]]:
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(channel(run_id))
        try:
            # Subscribe first, then send the current state, so no change between the two is lost.
            snap = await _snapshot(user_id, run_id)
            if snap is None:
                return
            first = RunStatusEvent(status=snap["status"], stage=snap["stage"])
            yield {"event": "run.status", "data": first.model_dump_json()}
            if snap["status"] in _TERMINAL_STATUS:
                return
            loop = asyncio.get_running_loop()
            close_at: float | None = None
            while close_at is None or loop.time() < close_at:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg is None:
                    continue
                body = json.loads(msg["data"])
                event, data = body["event"], body["data"]
                yield {"event": event, "data": json.dumps(data)}
                if event in _TERMINAL_EVENTS:
                    return
                if event == "run.status" and data.get("status") in _TERMINAL_STATUS and close_at is None:
                    close_at = loop.time() + _FINAL_EVENT_GRACE_S
        finally:
            await pubsub.unsubscribe()
            await pubsub.aclose()

    return EventSourceResponse(stream())


@router.post("/videos/{video_id}/runs", status_code=status.HTTP_202_ACCEPTED, tags=["videos"])
async def start_run(video_id: UUID, body: RunCreate, user_id: CurrentUser) -> RunCreated:
    async with tenant_tx(user_id) as conn:
        try:
            ref, events = await lifecycle.start(
                conn,
                video_id=video_id,
                mode=body.mode,
                voice=body.voice,
                voice_id=body.voice_id,
                fix_options=body.fix_options,
            )
        except lifecycle.VideoNotFound:
            raise not_found() from None
        except lifecycle.VideoNotStartable as e:
            raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
        except lifecycle.LiveRunExists:
            raise HTTPException(status.HTTP_409_CONFLICT, "video already has a live run") from None
    await publish_all(ref.id, events)  # after commit
    return RunCreated(run_id=str(ref.id))
