"""ffmpeg preprocess and render behind the Engines port.

propose runs the agent when a bundle is injected. With no bundle it keeps the stub, so the media
worker and the fixture tests stay on the keep-all plan. AI render speaks through the bundle when
that bundle can synthesize; otherwise it keeps the silent clip.
"""

import asyncio
from typing import Protocol, cast, runtime_checkable

from app.agent.agent import Draft, build_graph, checkpointer, initial_state, invoke, to_output
from app.agent.state import Bundle, make_call
from app.contracts.enums import VoiceMode
from app.contracts.pipeline import PreprocessResult, Proposal
from app.pipeline import media
from app.pipeline.engines import AgentOutput
from app.pipeline.proposal_stub import stub_proposal
from app.providers.bundle import Call, Clip, Providers
from app.runs.lifecycle import RunRef
from app.shared.storage import GcsStorage


@runtime_checkable
class _CanSpeak(Protocol):
    def synthesize(self, call: Call, text: str, voice_id: str) -> Clip: ...


def _propose(run: RunRef, pre: PreprocessResult, bundle: Bundle) -> Draft:
    raw = invoke(
        build_graph(checkpointer()),
        initial_state(run, pre),
        bundle,
        thread_id=str(run.id),
        workspace_id=str(run.workspace_id),
    )
    return to_output(raw)


class MediaEngines:
    def __init__(self, storage: GcsStorage, bundle: Bundle | Providers | None = None) -> None:
        self._storage = storage
        self._bundle = bundle

    async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult:
        return await media.preprocess(self._storage, run, raw_uri)

    async def propose(self, run: RunRef, pre: PreprocessResult) -> AgentOutput:
        bundle = self._bundle
        if bundle is None:
            return stub_proposal(run, pre)
        # Laya's decision and the graph's Decision are different classes; both expose p_yes.
        draft = await asyncio.to_thread(_propose, run, pre, cast(Bundle, bundle))
        return AgentOutput(
            script=draft.script,
            edit_plan=draft.edit_plan,
            seg_contexts=draft.seg_contexts,
            transcript_ctx=draft.transcript_ctx,
            checks=draft.checks,
            flags=draft.flags,
            accepted=draft.accepted,
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
