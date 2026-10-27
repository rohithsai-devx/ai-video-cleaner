"""FixtureEngines: the only fake engine. Canned agent output, and a render that copies the raw object.

The proposal lives in ``app/pipeline/fixtures/proposal.json``. Preprocessing reports fixed media facts.
"""

import json
from functools import lru_cache
from pathlib import Path

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import CheckResult, FixOptions, PreprocessResult, Proposal, Word
from app.pipeline.engines import AgentOutput
from app.runs.checks import FIX_OPTIONS_RESPECTED
from app.runs.lifecycle import RunRef
from app.shared.storage import GcsStorage

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "proposal.json"
_DURATION_S = 60.0


@lru_cache
def _proposal_fixture() -> AgentOutput:
    return AgentOutput.model_validate(json.loads(_FIXTURE.read_text()))


def _fixture_words() -> list[Word]:
    """Tokens from the canned script, timed inside each block, so clean-only can pass."""
    words: list[Word] = []
    for block in _proposal_fixture().script.blocks:
        start, end = block.source_span
        tokens = block.text.split()
        if not tokens:
            continue
        step = (end - start) / len(tokens)
        for i, token in enumerate(tokens):
            words.append(Word(w=token, start=start + i * step, end=start + (i + 1) * step))
    return words


def _proposal_for_options(options: FixOptions) -> AgentOutput:
    proposal = _proposal_fixture()
    allowed_drops = set()
    if options.filler:
        allowed_drops.add("filler")
    if options.retakes:
        allowed_drops.update(("false_start", "retake"))
    disallowed_retake_spans = [
        drop.span
        for drop in proposal.transcript_ctx.drops
        if drop.kind in ("false_start", "retake") and not options.retakes
    ]
    idle_ids = {
        context.seg_id for context in proposal.seg_contexts if context.by == "code" and context.cuttable
    }
    entries = []
    for entry in proposal.edit_plan.entries:
        idle_cut = entry.action == "cut" and entry.seg_id in idle_ids and not options.pauses
        disallowed_retake_cut = entry.action == "cut" and any(
            max(entry.src[0], start) < min(entry.src[1], end) for start, end in disallowed_retake_spans
        )
        disabled_speed = entry.action == "speed" and not options.slow_parts
        if idle_cut or disallowed_retake_cut or disabled_speed:
            entry = entry.model_copy(
                update={
                    "action": "keep",
                    "speed": 1.0,
                    "freeze_s": 0.0,
                    "reasoning": "Kept because this fix is turned off for the run.",
                }
            )
        entries.append(entry)
    checks = [check for check in proposal.checks if check.name != FIX_OPTIONS_RESPECTED]
    checks.append(CheckResult(name=FIX_OPTIONS_RESPECTED, passed=True, target="video_editor"))
    return proposal.model_copy(
        update={
            "transcript_ctx": proposal.transcript_ctx.model_copy(
                update={
                    "drops": [drop for drop in proposal.transcript_ctx.drops if drop.kind in allowed_drops]
                }
            ),
            "edit_plan": proposal.edit_plan.model_copy(update={"entries": entries}),
            "checks": checks,
        }
    )


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
            words=_fixture_words(),
            keyframes=[],
            segments=[],
        )

    async def propose(
        self,
        run: RunRef,
        pre: PreprocessResult,
        *,
        voice: VoiceMode = "original",
        fix_options: FixOptions | None = None,
    ) -> AgentOutput:
        del voice
        return _proposal_for_options(fix_options or FixOptions())

    async def render(
        self, run: RunRef, proposal: Proposal, output_uri: str, *, voice: VoiceMode = "original"
    ) -> None:
        del voice  # the fixture copies the raw object in either voice mode
        # The raw object stands in for the rendered video. The copy lands before the caller commits the row.
        await self._storage.copy(self._storage.raw_uri(run.video_id), output_uri)
