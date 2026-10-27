"""The agent graph, driven by a scripted bundle. No network and no live model."""

import ast
import json
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from app.agent.agent import build_graph, checkpointer, initial_state, invoke, to_output
from app.agent.agent import graph as studio_graph
from app.agent.state import Decision
from app.agent.tools.compare_frames import compare_frames
from app.contracts.pipeline import (
    Drop,
    EditPlan,
    EDLEntry,
    FixOptions,
    Keyframe,
    PreprocessResult,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    Step,
    TranscriptContext,
    Word,
)
from app.pipeline import media_engines as media_engines_module
from app.pipeline.engines import AgentOutput
from app.pipeline.media_engines import MediaEngines
from app.runs.checks import edl_valid
from app.runs.lifecycle import RunRef
from app.shared.storage import GcsStorage

_BACKEND = Path(__file__).resolve().parents[2]
_WS = "00000000-0000-4000-8000-000000000011"
REF = RunRef(
    id=UUID("00000000-0000-4000-8000-000000000010"),
    workspace_id=UUID(_WS),
    video_id=UUID("00000000-0000-4000-8000-000000000012"),
    status="agent_running",
    stage="agent",
    attempt=1,
    mode="review",
    duration_s=4.0,
)


def clip() -> PreprocessResult:
    return PreprocessResult(
        mezz_uri="gs://b/m.mp4",
        audio_uri="gs://b/a.wav",
        duration=4.0,
        fps=1.0,
        width=8,
        height=8,
        words=[
            Word(w="alpha", start=0.2, end=0.4),
            Word(w="beta", start=0.5, end=0.7),
            Word(w="quartz", start=1.2, end=1.5),
        ],
        keyframes=[Keyframe(frame_id="f1", t=0.2, uri="gs://b/f1.jpg", diff=0.42)],
        segments=[Segment(seg_id="s1", start=0.0, end=4.0, frame_ids=["f1"], active=True)],
    )


def clip_with_idle() -> PreprocessResult:
    return PreprocessResult(
        mezz_uri="gs://b/m.mp4",
        audio_uri="gs://b/a.wav",
        duration=6.0,
        fps=1.0,
        width=8,
        height=8,
        words=[
            Word(w="alpha", start=2.2, end=2.4),
            Word(w="beta", start=2.6, end=2.8),
            Word(w="quartz", start=3.1, end=3.4),
        ],
        keyframes=[Keyframe(frame_id="f1", t=3.0, uri="gs://b/f1.jpg", diff=0.42)],
        segments=[
            Segment(seg_id="s0", start=0.0, end=2.0, frame_ids=[], active=False),
            Segment(seg_id="s1", start=2.0, end=6.0, frame_ids=["f1"], active=True),
        ],
    )


def _active(pre: PreprocessResult) -> Segment:
    return next(seg for seg in pre.segments if seg.active)


def good_script(
    pre: PreprocessResult, *, text: str = "alpha beta", target_min: float = 0.5, target_max: float = 4.0
) -> Script:
    seg = _active(pre)
    return Script(
        blocks=[
            ScriptBlock(
                block_id="b1",
                text=text,
                seg_ids=[seg.seg_id],
                source_span=(seg.start, seg.end),
                target_min=target_min,
                target_max=target_max,
                est_dur=seg.end - seg.start,
            )
        ]
    )


def good_plan(pre: PreprocessResult, *, speed: float = 1.0) -> EditPlan:
    seg = _active(pre)
    return EditPlan(
        entries=[
            EDLEntry(
                seg_id=seg.seg_id,
                src=(seg.start, seg.end),
                action="keep",
                speed=speed,
                freeze_s=0.0,
                block_id="b1",
                reasoning="kept",
            )
        ]
    )


def fresh_segment() -> SegContext:
    return SegContext(
        seg_id="s1",
        label="fresh",
        reasoning="shown",
        cuttable=False,
        min_dur=0.3,
        max_dur=10.0,
        max_speed=2.0,
        by="vlm",
    )


class Scripted:
    """Stand-in bundle. Records calls and returns the objects it was given."""

    def __init__(
        self,
        *,
        script: Script,
        plan: EditPlan,
        p_yes: float | dict[str, float] = 0.7,
        seg: SegContext | None = None,
        transcripts: list[TranscriptContext] | None = None,
    ) -> None:
        self.script = script
        self.plan = plan
        self.p_yes = p_yes
        self.seg = seg or fresh_segment()
        self.transcripts = list(transcripts or [TranscriptContext(steps=[], key_terms=[], drops=[])])
        self.log: list[str] = []
        self.messages: list[Any] = []
        self.tools: list[Any] = []
        self.describes: list[dict[str, Any]] = []

    def describe(
        self, call: Any, frame_uris: list[str], transcript: str, hints: dict[str, Any]
    ) -> SegContext:
        self.log.append("describe")
        self.describes.append({"frames": frame_uris, "transcript": transcript, "hints": hints})
        return self.seg.model_copy(update={"seg_id": hints["seg_id"]})

    def complete(
        self, call: Any, messages: list[Any], schema: type[Any], tools: list[Any] | None = None
    ) -> Any:
        self.log.append(schema.__name__)
        self.messages.append(messages)
        self.tools.append(tools)
        if schema.__name__ == "TranscriptContext":
            return self.transcripts.pop(0)
        if schema.__name__ == "Script":
            return self.script
        if schema.__name__ == "EditPlan":
            return self.plan
        if schema.__name__ == "Critique":
            return schema(text="shorten the opening")
        raise AssertionError(schema.__name__)

    def yes_no(self, call: Any, question: str, ctx: str) -> Decision:
        self.log.append(f"yes_no:{call.stage}")
        score = self.p_yes[call.stage] if isinstance(self.p_yes, dict) else self.p_yes
        return Decision(p_yes=score)


def _graph():
    return build_graph(checkpointer())


def _run(bundle: Scripted, state: Any, *, graph: Any = None, interrupt_after: list[str] | None = None) -> Any:
    compiled = graph or _graph()
    raw = invoke(
        compiled,
        state,
        bundle,
        thread_id=str(REF.id),
        workspace_id=_WS,
        interrupt_after=interrupt_after,
    )
    return compiled, raw


def test_studio_export_leaves_checkpointing_to_langgraph_api() -> None:
    assert studio_graph.checkpointer is None


def test_orchestrator_is_the_only_router() -> None:
    edges = _graph().builder.edges
    assert edges == {
        ("__start__", "orchestrator"),
        ("vlm_context", "orchestrator"),
        ("transcript_context", "orchestrator"),
        ("script_writer", "orchestrator"),
        ("video_editor", "orchestrator"),
    }


def test_agent_package_does_not_write_run_status() -> None:
    root = _BACKEND / "app" / "agent"
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            module = ""
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
            elif isinstance(node, ast.Import):
                module = " ".join(alias.name for alias in node.names)
            assert "lifecycle" not in module, path
            assert not module.startswith("app.pipeline"), path


def test_accepts_at_the_default_threshold() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre), plan=good_plan(pre), p_yes=0.7)
    _compiled, raw = _run(bundle, initial_state(REF, pre))
    out = to_output(raw)
    script_at = bundle.log.index("Script")
    assert bundle.log.index("describe") < script_at
    assert bundle.log.index("TranscriptContext") < script_at
    assert bundle.log.index("EditPlan") > script_at
    assert bundle.log.count("Script") == 1
    assert bundle.log.count("EditPlan") == 1
    assert bundle.log.count("Critique") == 0
    assert out.accepted is True
    assert raw["stage"] == "done"
    assert any("quartz" in json.dumps(message) for message in bundle.messages)
    assert any("0.42" in json.dumps(message) for message in bundle.messages)
    bound = [tool for tools in bundle.tools if tools for tool in tools]
    # No tool is offered: the client has no tool-call loop, and a tool-call answer would not parse.
    assert bound == []
    assert bundle.describes[0]["frames"] == ["gs://b/f1.jpg"]


def test_disallowed_filler_drop_retries_transcript_context() -> None:
    pre = clip()
    bundle = Scripted(
        script=good_script(pre),
        plan=good_plan(pre),
        transcripts=[
            TranscriptContext(
                steps=[],
                key_terms=[],
                drops=[Drop(span=(0.2, 0.4), kind="filler", reason="filler")],
            ),
            TranscriptContext(steps=[], key_terms=[], drops=[]),
        ],
    )
    state = initial_state(REF, pre, fix_options=FixOptions(filler=False, retakes=False))
    _compiled, raw = _run(bundle, state)

    assert bundle.log.count("TranscriptContext") == 2
    assert raw["transcript_ctx"].drops == []
    first_transcript_messages = bundle.messages[0]
    assert "Only propose drops of these kinds: none" in first_transcript_messages[0]["content"]
    assert json.loads(first_transcript_messages[1]["content"])["allowed_drop_kinds"] == []
    editor_body = json.loads(bundle.messages[-1][1]["content"])
    assert editor_body["allowed"] == {"cut_idle_segments": True, "speed": True}


def test_initial_state_carries_voice_and_fix_options() -> None:
    state = initial_state(REF, clip(), voice="ai", fix_options=FixOptions(slow_parts=False))

    assert state.voice == "ai"
    assert state.fix_options == FixOptions(slow_parts=False)


def test_non_plain_chapter_title_routes_back_to_transcript_context() -> None:
    pre = clip()
    invalid = TranscriptContext(
        steps=[Step(step_id="s1", summary="Open the Reports page", span=(0.0, 4.0), title="Open block_b1")],
        key_terms=[],
        drops=[],
    )
    corrected = invalid.model_copy(
        update={"steps": [invalid.steps[0].model_copy(update={"title": "Open Reports"})]}
    )
    bundle = Scripted(
        script=good_script(pre),
        plan=good_plan(pre),
        transcripts=[invalid, corrected],
    )

    _compiled, raw = _run(bundle, initial_state(REF, pre))

    assert bundle.log.count("TranscriptContext") == 2
    assert raw["transcript_ctx"].steps[0].title == "Open Reports"
    assert to_output(raw).accepted is True


def test_rejection_below_the_threshold_returns_to_the_writer() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre), plan=good_plan(pre), p_yes=0.69)
    _compiled, raw = _run(bundle, initial_state(REF, pre))
    out = to_output(raw)
    assert bundle.log.count("Script") == 3
    assert bundle.log.count("EditPlan") == 3
    # 3 writer critiques + 3 editor critiques once the capped script reaches the editor.
    assert bundle.log.count("Critique") == 6
    assert bundle.log.count("yes_no:script_writer") == 3
    assert bundle.log.count("yes_no:video_editor") == 3
    assert raw["attempts"]["script_writer"] == 3
    assert raw["attempts"]["video_editor"] == 3
    assert "max_attempts" in raw["flags"]
    assert out.accepted is False
    assert len(out.edit_plan.entries) == 1


def test_yes_no_rejection_of_the_editor_returns_to_the_editor() -> None:
    pre = clip()
    bundle = Scripted(
        script=good_script(pre), plan=good_plan(pre), p_yes={"script_writer": 0.95, "video_editor": 0.69}
    )
    _compiled, raw = _run(bundle, initial_state(REF, pre))
    assert bundle.log.count("Script") == 1
    assert bundle.log.count("EditPlan") == 3
    assert bundle.log.count("yes_no:video_editor") == 3
    assert raw["attempts"]["video_editor"] == 3
    assert "max_attempts" in raw["flags"]
    assert to_output(raw).accepted is False


def test_failed_check_returns_to_script_writer_without_a_verdict() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre, text="alpha 99"), plan=good_plan(pre), p_yes=0.99)
    _compiled, raw = _run(bundle, initial_state(REF, pre))
    out = to_output(raw)
    assert bundle.log.count("Script") == 3
    # The capped script still gets one editor pass, so the proposal is complete for review.
    assert bundle.log.count("EditPlan") == 1
    assert not any(item.startswith("yes_no:") for item in bundle.log)
    # 3 writer attempts, then the edit-stage reroute counts a 4th before END.
    assert raw["attempts"]["script_writer"] == 4
    assert raw["attempts"].get("video_editor", 0) == 0
    assert out.accepted is False
    assert "max_attempts" in out.flags
    assert len(out.edit_plan.entries) == 1


def test_output_without_an_edit_plan_raises_instead_of_saving_an_empty_one() -> None:
    pre = clip()
    state = initial_state(REF, pre).model_copy(
        update={
            "stage": "script",
            "script": good_script(pre),
            "transcript_ctx": TranscriptContext(steps=[], key_terms=[], drops=[]),
        }
    )
    with pytest.raises(RuntimeError, match="without a renderable edit plan"):
        to_output(state.model_dump(mode="json"))
    empty = state.model_copy(update={"stage": "edit", "edit_plan": EditPlan(entries=[])})
    with pytest.raises(RuntimeError, match="without a renderable edit plan"):
        to_output(empty.model_dump(mode="json"))


def test_editor_gets_its_retries_when_the_writer_is_already_capped() -> None:
    pre = clip()
    state = initial_state(REF, pre).model_copy(
        update={
            "stage": "edit",
            "attempts": {"script_writer": 3},
            "seg_contexts": [fresh_segment()],
            "transcript_ctx": TranscriptContext(steps=[], key_terms=[], drops=[]),
            "script": good_script(pre, text="alpha 99"),  # clean_only: script_writer, already capped
            "edit_plan": good_plan(pre, speed=9.0),  # edl_valid: video_editor, alive
        }
    )
    bundle = Scripted(script=state.script, plan=state.edit_plan, p_yes=0.99)  # type: ignore[arg-type]
    _compiled, raw = _run(bundle, state)
    assert bundle.log.count("EditPlan") == 2  # the pre-seeded plan plus two retries: the third redo caps
    assert bundle.log.count("Script") == 0  # the capped writer is not retried
    assert raw["attempts"]["video_editor"] == 3
    assert raw["attempts"]["script_writer"] == 3  # the capped writer is never re-counted
    assert "max_attempts" in raw["flags"]


def test_failed_edit_check_returns_to_the_editor() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre), plan=good_plan(pre, speed=9.0), p_yes=0.99)
    _compiled, raw = _run(bundle, initial_state(REF, pre))
    assert bundle.log.count("Script") == 1
    assert bundle.log.count("EditPlan") == 3
    assert bundle.log.count("yes_no:script_writer") == 1
    assert bundle.log.count("yes_no:video_editor") == 0
    assert raw["attempts"]["video_editor"] == 3
    assert to_output(raw).accepted is False


def test_edit_stage_check_can_return_to_script_writer() -> None:
    pre = clip()
    state = initial_state(REF, pre).model_copy(
        update={
            "stage": "edit",
            "seg_contexts": [fresh_segment()],
            "transcript_ctx": TranscriptContext(steps=[], key_terms=[], drops=[]),
            "script": good_script(pre, target_min=5.0, target_max=6.0),
            "edit_plan": good_plan(pre),
        }
    )
    bundle = Scripted(script=state.script, plan=state.edit_plan, p_yes=0.99)  # type: ignore[arg-type]
    _compiled, raw = _run(bundle, state)
    assert bundle.log.count("describe") == 0
    # The writer redo flips the stage back to script, so its cap now routes through the editor.
    assert bundle.log.count("EditPlan") == 1
    assert bundle.log.count("Script") == 2
    assert not any(item.startswith("yes_no:") for item in bundle.log)
    assert raw["attempts"]["script_writer"] == 4
    assert "max_attempts" in raw["flags"]
    assert to_output(raw).accepted is False


def test_idle_segment_skips_describe_and_a_second_pass_replaces() -> None:
    pre = clip_with_idle()
    stale = fresh_segment().model_copy(update={"label": "stale"})
    state = initial_state(REF, pre).model_copy(update={"seg_contexts": [stale]})
    bundle = Scripted(script=good_script(pre), plan=good_plan(pre), p_yes=0.7)
    _compiled, raw = _run(bundle, state)
    out = to_output(raw)
    active = [ctx for ctx in out.seg_contexts if ctx.seg_id == "s1"]
    idle = [ctx for ctx in out.seg_contexts if ctx.seg_id == "s0"]
    assert len(active) == 1 and active[0].label == "fresh" and active[0].by == "vlm"
    assert len(idle) == 1 and idle[0].label == "idle" and idle[0].by == "code"
    assert bundle.log.count("describe") == 1
    assert bundle.describes[0]["hints"]["seg_id"] == "s1"
    assert out.accepted is True


def test_resume_does_not_repeat_a_finished_node() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre), plan=good_plan(pre), p_yes=0.7)
    graph, paused = _run(bundle, initial_state(REF, pre), interrupt_after=["script_writer"])
    assert paused["stage"] != "done"
    assert bundle.log.count("Script") == 1
    assert bundle.log.count("EditPlan") == 0
    assert any("quartz" in json.dumps(message) for message in bundle.messages)
    _graph_again, raw = _run(bundle, None, graph=graph)
    assert bundle.log.count("Script") == 1
    assert bundle.log.count("describe") == 1
    assert bundle.log.count("TranscriptContext") == 1
    assert bundle.log.count("EditPlan") == 1
    assert to_output(raw).accepted is True


def test_compare_frames_returns_stored_diff_scores() -> None:
    frames = [
        Keyframe(frame_id="a", t=1.0, uri="gs://b/a.jpg", diff=0.25),
        Keyframe(frame_id="b", t=2.0, uri="gs://b/b.jpg", diff=0.5),
    ]
    assert compare_frames(frames) == [
        {"frame_id": "a", "t": 1.0, "diff": 0.25},
        {"frame_id": "b", "t": 2.0, "diff": 0.5},
    ]
    assert compare_frames(frames, ["b"]) == [{"frame_id": "b", "t": 2.0, "diff": 0.5}]


def test_fixture_json_loads_with_accepted_true() -> None:
    raw = json.loads((_BACKEND / "app" / "pipeline" / "fixtures" / "proposal.json").read_text())
    assert "accepted" not in raw
    assert AgentOutput.model_validate(raw).accepted is True


async def test_propose_returns_a_plan_the_edit_check_accepts() -> None:
    pre = clip()
    bundle = Scripted(script=good_script(pre, text="alpha bright beta"), plan=good_plan(pre), p_yes=0.7)
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")
    out = await MediaEngines(storage, bundle=bundle).propose(
        REF, pre, voice="ai", fix_options=FixOptions(slow_parts=False)
    )
    assert out.accepted is True
    assert out.script.blocks[0].text == "alpha bright beta"
    assert edl_valid(out.edit_plan, out.seg_contexts, pre.duration).passed is True
    assert next(check for check in out.checks if check.name == "clean_only").passed is True
    assert json.loads(bundle.messages[-1][1]["content"])["allowed"]["speed"] is False


async def test_propose_uses_fresh_checkpoint_threads_per_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saver = checkpointer()
    monkeypatch.setattr(media_engines_module, "checkpointer", lambda: saver)
    pre = clip()
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")

    for attempt in (1, 2):
        bundle = Scripted(script=good_script(pre), plan=good_plan(pre), p_yes=0.7)
        await MediaEngines(storage, bundle=bundle).propose(
            replace(REF, attempt=attempt), pre, voice="ai", fix_options=FixOptions(slow_parts=False)
        )

    threads = {
        configurable["thread_id"]
        for item in saver.list(None)
        if (configurable := item.config.get("configurable")) is not None
    }
    assert threads == {f"{REF.id}:1", f"{REF.id}:2"}
