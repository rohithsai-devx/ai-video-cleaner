"""FixtureEngines: the only fake engine. Canned agent output, and a render that copies the raw object.

The proposal lives in ``app/pipeline/fixtures/proposal.json``. Preprocessing reports fixed media facts.
"""

import json
from functools import lru_cache
from pathlib import Path

from app.contracts.pipeline import PreprocessResult, Proposal
from app.pipeline.engines import AgentOutput
from app.runs.lifecycle import RunRef
from app.shared.storage import GcsStorage

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "proposal.json"
_DURATION_S = 12.0


@lru_cache
def _proposal_fixture() -> AgentOutput:
    return AgentOutput.model_validate(json.loads(_FIXTURE.read_text()))


class FixtureEngines:
    def __init__(self, storage: GcsStorage) -> None:
        self._storage = storage

    async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult:
        return PreprocessResult(
            mezz_uri=raw_uri,
            audio_uri=raw_uri,
            duration=_DURATION_S,
            fps=30.0,
            width=1280,
            height=720,
            words=[],
            keyframes=[],
            segments=[],
        )

    async def propose(self, run: RunRef, pre: PreprocessResult) -> AgentOutput:
        return _proposal_fixture()

    async def render(self, run: RunRef, proposal: Proposal, output_uri: str) -> None:
        # The raw object stands in for the rendered video. The copy lands before the caller commits the row.
        await self._storage.copy(self._storage.raw_uri(run.video_id), output_uri)
