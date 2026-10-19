"""The port for what the pipeline stages compute. Phase 3 backs it with the provider factory.

Stages own the transactions and the status moves; an engine only computes. ``render`` writes its output
object before returning, so the caller can commit the row that points to it.
"""

from typing import Protocol

from pydantic import BaseModel

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import (
    CheckResult,
    EditPlan,
    PreprocessResult,
    Proposal,
    Script,
    SegContext,
    TranscriptContext,
)
from app.runs.lifecycle import RunRef


class AgentOutput(BaseModel):
    script: Script
    edit_plan: EditPlan
    seg_contexts: list[SegContext]
    transcript_ctx: TranscriptContext
    checks: list[CheckResult]
    flags: list[str] = []
    accepted: bool = True  # false when the agent hit its attempt cap; fixture JSON omits it


class Engines(Protocol):
    async def preprocess(self, run: RunRef, raw_uri: str) -> PreprocessResult: ...

    async def propose(self, run: RunRef, pre: PreprocessResult) -> AgentOutput: ...

    async def render(
        self, run: RunRef, proposal: Proposal, output_uri: str, *, voice: VoiceMode = "original"
    ) -> None: ...
