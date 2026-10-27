"""ffmpeg preprocess and render behind the Engines port.

propose runs the agent when a bundle is injected. With no bundle it keeps the stub, so the media
worker and the fixture tests stay on the keep-all plan. AI render speaks through the bundle when
that bundle can synthesize; otherwise it keeps the silent clip.
"""

import asyncio
import logging
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any, Protocol, cast, runtime_checkable

from app.agent.agent import Draft, build_graph, checkpointer, initial_state, invoke, to_output
from app.agent.state import Bundle, make_call
from app.contracts.enums import VoiceMode
from app.contracts.events import RunProgressEvent
from app.contracts.pipeline import (
    EditPlan,
    FixOptions,
    PreprocessResult,
    Proposal,
    SegContext,
    TranscriptContext,
)
from app.pipeline import media
from app.pipeline.engines import AgentOutput
from app.pipeline.proposal_stub import stub_proposal
from app.providers.bundle import Call, Clip, Providers
from app.runs.chapters import chapters_from_steps
from app.runs.checks import fix_options_respected
from app.runs.lifecycle import RunRef
from app.shared import events
from app.shared.storage import GcsStorage

log = logging.getLogger(__name__)

_PROGRESS_NODES = {"vlm_context", "transcript_context", "video_editor"}


@runtime_checkable
class _CanSpeak(Protocol):
    def synthesize(self, call: Call, text: str, voice_id: str) -> Clip: ...


def _propose(
    run: RunRef,
    pre: PreprocessResult,
    bundle: Bundle,
    voice: VoiceMode,
    fix_options: FixOptions,
    on_update: Callable[[str, dict[str, Any]], None] | None = None,
) -> Draft:
    raw = invoke(
        build_graph(checkpointer()),
        initial_state(run, pre, voice=voice, fix_options=fix_options),
        bundle,
        thread_id=f"{run.id}:{run.attempt}",
        workspace_id=str(run.workspace_id),
        on_update=on_update,
    )
    return to_output(raw)


def _progress(state: dict[str, Any]) -> RunProgressEvent:
    seg_contexts: list[SegContext] | None = None
    if state.get("has_seg_contexts"):
        seg_contexts = [
            context if isinstance(context, SegContext) else SegContext.model_validate(context)
            for context in state.get("seg_contexts", [])
        ]

    edit_plan: EditPlan | None = None
    if state.get("has_edit_plan"):
        value = state.get("edit_plan")
        edit_plan = value if isinstance(value, EditPlan) else EditPlan.model_validate(value)

    transcript: TranscriptContext | None = None
    if state.get("has_transcript_ctx"):
        value = state.get("transcript_ctx")
        transcript = (
            value if isinstance(value, TranscriptContext) else TranscriptContext.model_validate(value)
        )

    pauses = None
    if seg_contexts is not None and edit_plan is not None:
        contexts = {context.seg_id: context for context in seg_contexts}
        pauses = sum(
            entry.action == "cut"
            and (context := contexts.get(entry.seg_id)) is not None
            and context.by == "code"
            for entry in edit_plan.entries
        )

    filler = None if transcript is None else sum(drop.kind == "filler" for drop in transcript.drops)
    retakes = (
        None
        if transcript is None
        else sum(drop.kind in ("false_start", "retake") for drop in transcript.drops)
    )
    slow_parts = None if edit_plan is None else sum(entry.action == "speed" for entry in edit_plan.entries)
    return RunProgressEvent(
        pauses=pauses,
        filler=filler,
        retakes=retakes,
        slow_parts=slow_parts,
        chapters=[] if transcript is None else chapters_from_steps(transcript.steps),
    )


class MediaEngines:
    def __init__(self, storage: GcsStorage, bundle: Bundle | Providers | None = None) -> None:
        self._storage = storage
        self._bundle = bundle

    async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult:
        return await media.preprocess(self._storage, run, raw_uri)

    async def propose(
        self,
        run: RunRef,
        pre: PreprocessResult,
        *,
        voice: VoiceMode = "original",
        fix_options: FixOptions | None = None,
    ) -> AgentOutput:
        bundle = self._bundle
        if bundle is None:
            options = fix_options or FixOptions()
            output = stub_proposal(run, pre)
            state = initial_state(run, pre, voice=voice, fix_options=options).model_copy(
                update={"transcript_ctx": output.transcript_ctx, "edit_plan": output.edit_plan}
            )
            return output.model_copy(update={"checks": [*output.checks, fix_options_respected(state)]})
        # Laya's decision and the graph's Decision are different classes; both expose p_yes.
        loop = asyncio.get_running_loop()
        pending: list[Future[None]] = []
        progress_state: dict[str, Any] = {}

        def on_update(node: str, update: dict[str, Any]) -> None:
            if node not in _PROGRESS_NODES:
                return
            try:
                progress_state.update(update)
                if node == "vlm_context":
                    progress_state["has_seg_contexts"] = True
                elif node == "transcript_context":
                    progress_state["has_transcript_ctx"] = True
                elif node == "video_editor":
                    progress_state["has_edit_plan"] = True
                event = _progress(progress_state)
                pending.append(
                    asyncio.run_coroutine_threadsafe(events.publish(run.id, "run.progress", event), loop)
                )
            except Exception:  # noqa: BLE001 - progress must not interrupt proposal generation
                log.warning("could not schedule progress for run %s", run.id, exc_info=True)

        try:
            draft = await asyncio.to_thread(
                _propose,
                run,
                pre,
                cast(Bundle, bundle),
                voice,
                fix_options or FixOptions(),
                on_update,
            )
        finally:
            if pending:
                await asyncio.gather(
                    *(asyncio.wrap_future(future) for future in pending), return_exceptions=True
                )
        return AgentOutput(
            script=draft.script,
            edit_plan=draft.edit_plan,
            seg_contexts=draft.seg_contexts,
            transcript_ctx=draft.transcript_ctx,
            checks=draft.checks,
            flags=draft.flags,
            accepted=draft.accepted,
            spots=draft.spots,
        )

    async def render(
        self, run: RunRef, proposal: Proposal, output_uri: str, *, voice: VoiceMode = "original"
    ) -> None:
        speaker = self._speech(run) if voice == "ai" else None
        await media.render(self._storage, run, proposal, output_uri, voice=voice, speaker=speaker)

    def _speech(self, run: RunRef) -> media.Speaker | None:
        bundle = self._bundle
        if not isinstance(bundle, _CanSpeak):
            return None

        def speak(text: str) -> tuple[bytes, float]:
            # ponytail: "" uses the configured speech voice; RunRef has no voice_id.
            clip = bundle.synthesize(make_call(str(run.workspace_id), str(run.id), "voice"), text, "")
            return clip.audio, clip.duration_s

        return speak
