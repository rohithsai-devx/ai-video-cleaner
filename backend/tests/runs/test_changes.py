"""Applied-change projection and agent-copy checks; no database required."""

import json
from pathlib import Path

from app.contracts.pipeline import AgentState, BlockPatch, Fix, FixPatch, PreprocessResult, Proposal, Spot
from app.runs.changes import changes
from app.runs.checks import reasons_plain

_FIXTURE = Path(__file__).resolve().parents[2] / "app" / "pipeline" / "fixtures" / "proposal.json"


def _proposal() -> Proposal:
    return Proposal.model_validate(json.loads(_FIXTURE.read_text()))


def test_changes_cover_each_kind_and_detect_an_undo() -> None:
    agent = _proposal()
    entries = {entry.seg_id: entry for entry in agent.edit_plan.entries}
    entries["seg_01"] = entries["seg_01"].model_copy(update={"action": "cut"})
    entries["seg_03"] = entries["seg_03"].model_copy(update={"action": "speed", "speed": 1.5})
    entries["seg_05"] = entries["seg_05"].model_copy(update={"action": "cut"})
    entries["seg_06"] = entries["seg_06"].model_copy(update={"action": "freeze", "freeze_s": 2.0})
    agent = agent.model_copy(
        update={"edit_plan": agent.edit_plan.model_copy(update={"entries": list(entries.values())})}
    )

    latest = agent.model_copy(
        update={
            "edit_plan": agent.edit_plan.model_copy(
                update={
                    "entries": [
                        entry.model_copy(update={"action": "keep", "freeze_s": 0.0})
                        if entry.seg_id == "seg_02"
                        else entry
                        for entry in agent.edit_plan.entries
                    ]
                }
            )
        }
    )

    result = changes(agent, latest)
    assert {item.kind for item in result} == {"pause", "filler", "retake", "cut", "speed", "hold"}
    assert len(result) == 6
    assert {item.kind: item.reason for item in result}["filler"] == agent.transcript_ctx.drops[0].reason
    assert {item.kind: item.undone for item in result}["pause"] is True
    assert {item.kind: item.speed for item in result}["speed"] == 1.5
    assert {item.kind: item.hold_s for item in result}["hold"] == 2.0


def test_drop_without_an_overlapping_cut_does_not_make_a_change() -> None:
    proposal = _proposal()

    result = changes(proposal, proposal)

    assert all(item.kind != "filler" for item in result)


def test_reasons_plain_fails_when_copy_contains_an_internal_id() -> None:
    proposal = _proposal()
    state = AgentState(
        run_id=proposal.run_id,
        mode="review",
        voice="original",
        voice_wps=2.0,
        pre=PreprocessResult(
            mezz_uri="m",
            audio_uri="a",
            duration=60,
            fps=30,
            width=1280,
            height=720,
            words=[],
            keyframes=[],
            segments=[],
        ),
        transcript_ctx=proposal.transcript_ctx,
        edit_plan=proposal.edit_plan.model_copy(
            update={
                "entries": [
                    entry.model_copy(update={"reasoning": "Cut seg_02"})
                    if entry.seg_id == "seg_02"
                    else entry
                    for entry in proposal.edit_plan.entries
                ]
            }
        ),
    )

    result = reasons_plain(state)

    assert result.passed is False
    assert result.target == "video_editor"
    assert result.message == "Write reasons for the viewer, without ids."


def test_reasons_plain_rejects_a_check_name() -> None:
    proposal = _proposal()
    state = AgentState(
        run_id=proposal.run_id,
        mode="review",
        voice="original",
        voice_wps=2.0,
        pre=PreprocessResult(
            mezz_uri="m",
            audio_uri="a",
            duration=60,
            fps=30,
            width=1280,
            height=720,
            words=[],
            keyframes=[],
            segments=[],
        ),
        transcript_ctx=proposal.transcript_ctx,
        edit_plan=proposal.edit_plan.model_copy(
            update={
                "entries": [
                    entry.model_copy(update={"reasoning": "This passes clean_only."})
                    if entry.seg_id == "seg_02"
                    else entry
                    for entry in proposal.edit_plan.entries
                ]
            }
        ),
    )

    assert reasons_plain(state).passed is False


def test_reasons_plain_targets_spot_writer_for_internal_copy() -> None:
    proposal = _proposal()
    state = AgentState(
        run_id=proposal.run_id,
        mode="review",
        voice="original",
        voice_wps=2.0,
        pre=PreprocessResult(
            mezz_uri="m",
            audio_uri="a",
            duration=60,
            fps=30,
            width=1280,
            height=720,
            words=[],
            keyframes=[],
            segments=[],
        ),
        transcript_ctx=proposal.transcript_ctx,
        edit_plan=proposal.edit_plan,
        spots=[
            Spot(
                spot_id="spot-1",
                span=(0.0, 1.0),
                question="Should seg_02 stay?",
                fixes=[
                    Fix(
                        fix_id="fix-1",
                        label="Keep it",
                        patch=FixPatch(block=BlockPatch(block_id="b1", text="Keep it.")),
                    )
                ],
            )
        ],
    )

    result = reasons_plain(state)

    assert result.passed is False
    assert result.target == "spot_writer"
