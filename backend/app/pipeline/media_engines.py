"""ffmpeg preprocess and render behind the Engines port. No model calls."""

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import PreprocessResult, Proposal
from app.pipeline import media
from app.pipeline.engines import AgentOutput
from app.pipeline.proposal_stub import stub_proposal
from app.runs.lifecycle import RunRef
from app.shared.storage import GcsStorage


class MediaEngines:
    def __init__(self, storage: GcsStorage) -> None:
        self._storage = storage

    async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult:
        return await media.preprocess(self._storage, run, raw_uri)

    async def propose(self, run: RunRef, pre: PreprocessResult) -> AgentOutput:
        return stub_proposal(run, pre)

    async def render(
        self, run: RunRef, proposal: Proposal, output_uri: str, *, voice: VoiceMode = "original"
    ) -> None:
        await media.render(self._storage, run, proposal, output_uri, voice=voice)
