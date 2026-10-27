"""Pure AI voice script-line projection."""

import json
from pathlib import Path

import pytest

from app.contracts.pipeline import Proposal
from app.runs.script_lines import script_lines

_FIXTURE = Path(__file__).resolve().parents[2] / "app" / "pipeline" / "fixtures" / "proposal.json"


def _proposal() -> Proposal:
    return Proposal.model_validate(json.loads(_FIXTURE.read_text()))


def test_ai_lines_start_on_first_kept_segment_and_report_overflow() -> None:
    proposal = _proposal()
    first = proposal.script.blocks[0].model_copy(update={"est_dur": 15.0})
    proposal = proposal.model_copy(
        update={"script": proposal.script.model_copy(update={"blocks": [first, *proposal.script.blocks[1:]]})}
    )

    [line, *_] = script_lines(proposal, voice="ai")

    assert line.block_id == "b1"
    assert line.start == 0.0
    assert line.end == 15.0
    assert line.overflow_s == pytest.approx(2.6)


def test_original_voice_has_no_script_lines() -> None:
    assert script_lines(_proposal(), voice="original") == []
