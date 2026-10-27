"""Chapter projection tests; these do not require the database."""

import json
from pathlib import Path

from app.contracts.pipeline import Proposal, Step
from app.runs.chapters import chapters

_FIXTURE = Path(__file__).resolve().parents[2] / "app" / "pipeline" / "fixtures" / "proposal.json"


def _proposal(steps: list[Step]) -> Proposal:
    proposal = Proposal.model_validate(json.loads(_FIXTURE.read_text()))
    transcript = proposal.transcript_ctx.model_copy(update={"steps": steps})
    return proposal.model_copy(update={"transcript_ctx": transcript})


def test_chapters_are_ordered_and_end_at_next_step() -> None:
    proposal = _proposal(
        [
            Step(step_id="step_later", summary="Later step", span=(12.0, 18.0), title="Review results"),
            Step(step_id="step_first", summary="First step", span=(2.0, 7.0), title="Start project"),
        ]
    )

    assert [chapter.model_dump() for chapter in chapters(proposal)] == [
        {"title": "Start project", "start": 2.0, "end": 12.0},
        {"title": "Review results", "start": 12.0, "end": 18.0},
    ]


def test_empty_chapter_title_uses_first_four_summary_words() -> None:
    proposal = _proposal(
        [Step(step_id="s1", summary="Set up a new project in minutes", span=(0.0, 4.0), title="")]
    )

    assert chapters(proposal)[0].title == "Set up a new"


def test_no_steps_produces_no_chapters() -> None:
    assert chapters(_proposal([])) == []
