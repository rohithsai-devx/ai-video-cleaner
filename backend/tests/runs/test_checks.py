"""Worked examples for the mechanical checks. Expected values are literals, not recomputed."""

import pytest

from app.contracts.pipeline import (
    Agent,
    AgentState,
    CheckResult,
    Drop,
    EditPlan,
    EDLEntry,
    FixOptions,
    PreprocessResult,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    TranscriptContext,
    Word,
)
from app.runs.checks import (
    clean_only,
    coverage_order,
    edl_covers_script,
    fix_options_respected,
    key_terms_kept,
    length_fit,
    nothing_invented,
    recheck,
)


def _block(**overrides: object) -> ScriptBlock:
    data: dict[str, object] = {
        "block_id": "b1",
        "text": "alpha beta",
        "seg_ids": ["s1"],
        "source_span": (0.0, 4.0),
        "target_min": 1.0,
        "target_max": 2.0,
        "est_dur": 1.0,
    }
    data.update(overrides)
    return ScriptBlock.model_validate(data)


def _ctx(seg_id: str = "s1", screen: list[str] | None = None) -> SegContext:
    return SegContext(
        seg_id=seg_id,
        label="screen",
        reasoning="visible",
        cuttable=False,
        min_dur=0.3,
        max_dur=10.0,
        max_speed=2.0,
        screen_text=screen or [],
        by="code",
    )


def _seg(seg_id: str, *, active: bool, start: float = 0.0) -> Segment:
    return Segment(seg_id=seg_id, start=start, end=start + 4.0, frame_ids=[], active=active)


def _entry(
    seg_id: str = "s1",
    src: tuple[float, float] = (0.0, 4.0),
    action: str = "keep",
    speed: float = 1.0,
    freeze_s: float = 0.0,
    block_id: str | None = "b1",
) -> EDLEntry:
    return EDLEntry.model_validate(
        {
            "seg_id": seg_id,
            "src": src,
            "action": action,
            "speed": speed,
            "freeze_s": freeze_s,
            "block_id": block_id,
            "reasoning": "kept",
        }
    )


def _expect(
    result: CheckResult, *, name: str, passed: bool, target: Agent, ref_id: str | None, message: str
) -> None:
    assert result == CheckResult(name=name, passed=passed, target=target, ref_id=ref_id, message=message)


def test_length_fit_rejects_speech_outside_the_block_target() -> None:
    # "one two three four five" is 5 words; 5 / 2 = 2.5, outside 1.0..2.0
    script = Script(blocks=[_block(text="one two three four five")])
    _expect(
        length_fit(script, 2.0),
        name="length_fit",
        passed=False,
        target="script_writer",
        ref_id="b1",
        message="b1: 2.5s outside 1.0..2.0",
    )


def test_length_fit_allows_speech_on_the_target_boundary() -> None:
    # "alpha beta" is 2 words; 2 / 2 = 1.0, equal to target_min
    script = Script(blocks=[_block(text="alpha beta", target_min=1.0, target_max=2.0)])
    _expect(
        length_fit(script, 2.0),
        name="length_fit",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


def test_length_fit_tolerates_word_granularity_at_a_single_value_target() -> None:
    # 22 words / 2 = 11.0s. A zero-width band of 10.777 cannot be hit exactly by any word count,
    # so the check accepts the nearest step within half a word (0.25s at 2 words per second).
    script = Script(
        blocks=[_block(text=" ".join(["word"] * 22), target_min=10.777, target_max=10.777, est_dur=11.0)]
    )
    _expect(
        length_fit(script, 2.0),
        name="length_fit",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


def test_key_terms_kept_rejects_a_term_spoken_in_the_span_but_missing_from_the_block() -> None:
    words = [Word(w="Export", start=1.0, end=1.4)]
    script = Script(blocks=[_block(text="Open the menu.", source_span=(0.0, 5.0))])
    _expect(
        key_terms_kept(script, ["Export"], words),
        name="key_terms_kept",
        passed=False,
        target="script_writer",
        ref_id="b1",
        message="b1: missing Export",
    )


def test_key_terms_kept_allows_a_different_case_and_ignores_a_term_outside_the_span() -> None:
    # "export" matches Export. PDF starts at the span end, so it was not spoken here.
    words = [Word(w="export", start=1.0, end=1.4), Word(w="PDF", start=5.0, end=5.4)]
    script = Script(blocks=[_block(text="open the export menu", source_span=(0.0, 5.0))])
    _expect(
        key_terms_kept(script, ["Export", "PDF"], words),
        name="key_terms_kept",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


def test_coverage_order_rejects_an_unused_active_segment() -> None:
    script = Script(blocks=[_block(seg_ids=["s2"])])
    _expect(
        coverage_order(script, [_seg("s1", active=True), _seg("s2", active=True, start=4.0)]),
        name="coverage_order",
        passed=False,
        target="script_writer",
        ref_id="s1",
        message="s1: active segment unused",
    )


def test_coverage_order_rejects_a_segment_in_two_blocks() -> None:
    script = Script(
        blocks=[
            _block(block_id="b1", seg_ids=["s1"], source_span=(0.0, 4.0)),
            _block(block_id="b2", seg_ids=["s1"], source_span=(4.0, 8.0)),
        ]
    )
    _expect(
        coverage_order(script, [_seg("s1", active=True)]),
        name="coverage_order",
        passed=False,
        target="script_writer",
        ref_id="s1",
        message="s1: in two blocks",
    )


def test_coverage_order_rejects_blocks_out_of_source_order() -> None:
    script = Script(
        blocks=[
            _block(block_id="b1", seg_ids=["s1"], source_span=(5.0, 9.0)),
            _block(block_id="b2", seg_ids=["s2"], source_span=(0.0, 4.0)),
        ]
    )
    _expect(
        coverage_order(script, [_seg("s1", active=True, start=5.0), _seg("s2", active=True)]),
        name="coverage_order",
        passed=False,
        target="script_writer",
        ref_id="b2",
        message="b2: out of source order",
    )


def test_coverage_order_allows_used_active_segments_and_an_unused_inactive_one() -> None:
    script = Script(
        blocks=[
            _block(block_id="b1", seg_ids=["s1"], source_span=(0.0, 4.0)),
            _block(block_id="b2", seg_ids=["s2"], source_span=(4.0, 8.0)),
        ]
    )
    segments = [
        _seg("s1", active=True),
        _seg("s2", active=True, start=4.0),
        _seg("s3", active=False, start=8.0),
    ]
    _expect(
        coverage_order(script, segments),
        name="coverage_order",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


@pytest.mark.parametrize(
    ("text", "words", "screen", "passed", "message"),
    [
        ("Total 42", [], [], False, "b1: invented 42"),
        ("Total 42", [], ["42"], True, ""),
        ("See https://example.com/docs", [], [], False, "b1: invented https://example.com/docs"),
        (
            "See https://example.com/docs",
            [Word(w="https://example.com/docs", start=1.0, end=1.5)],
            [],
            True,
            "",
        ),
        ('Press "Save"', [], [], False, "b1: invented Save"),
        ('Press "Save"', [], ["Save"], True, ""),
    ],
)
def test_nothing_invented(
    text: str, words: list[Word], screen: list[str], passed: bool, message: str
) -> None:
    script = Script(blocks=[_block(text=text, seg_ids=["s1"], source_span=(0.0, 5.0))])
    result = nothing_invented(script, words, [_ctx("s1", screen), _ctx("s2", ["42", "Save"])])
    _expect(
        result,
        name="nothing_invented",
        passed=passed,
        target="script_writer",
        ref_id="b1" if not passed else None,
        message=message,
    )


def test_clean_only_rejects_a_word_missing_from_the_source_transcript() -> None:
    words = [Word(w="export", start=0.2, end=0.8)]
    script = Script(blocks=[_block(text="export more")])
    _expect(
        clean_only(script, words, "original"),
        name="clean_only",
        passed=False,
        target="script_writer",
        ref_id="b1",
        message="b1: more not in the source transcript",
    )


def test_clean_only_allows_any_transcript_word_ignoring_case() -> None:
    # The word sits outside the block span; clean-only uses the whole transcript.
    words = [Word(w="export", start=8.0, end=8.4)]
    script = Script(blocks=[_block(text="Export", source_span=(0.0, 2.0))])
    _expect(
        clean_only(script, words, "original"),
        name="clean_only",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


def test_clean_only_skips_when_voice_is_ai() -> None:
    script = Script(blocks=[_block(text="invented line")])
    _expect(
        clean_only(script, [], "ai"),
        name="clean_only",
        passed=True,
        target="script_writer",
        ref_id=None,
        message="",
    )


def test_edl_covers_script_rejects_when_edited_duration_is_off_by_more_than_half_a_second() -> None:
    # (4 - 0) / 1 + 0 = 4.0; |4.0 - 2.0| = 2.0 > 0.5
    script = Script(blocks=[_block(est_dur=2.0)])
    plan = EditPlan(entries=[_entry(src=(0.0, 4.0), speed=1.0, freeze_s=0.0)])
    _expect(
        edl_covers_script(script, plan),
        name="edl_covers_script",
        passed=False,
        target="video_editor",
        ref_id="b1",
        message="b1: edited 4.0s vs estimated 2.0s",
    )


def test_edl_covers_script_counts_speed_and_freeze_and_ignores_cuts() -> None:
    # (4 - 0) / 2 + 0.5 = 2.5. The 16s cut is this block's segment and does not count.
    # |4.0 - 3.5| = 0.5 is still inside the tolerance.
    script = Script(
        blocks=[
            _block(block_id="b1", seg_ids=["s1", "s2"], est_dur=2.5),
            _block(block_id="b2", seg_ids=["s3"], est_dur=3.5, source_span=(4.0, 8.0)),
        ]
    )
    plan = EditPlan(
        entries=[
            _entry("s1", src=(0.0, 4.0), action="speed", speed=2.0, freeze_s=0.5),
            _entry("s2", src=(4.0, 20.0), action="cut", block_id="b1"),
            _entry("s3", src=(0.0, 4.0), speed=1.0, freeze_s=0.0, block_id="b2"),
        ]
    )
    _expect(
        edl_covers_script(script, plan),
        name="edl_covers_script",
        passed=True,
        target="video_editor",
        ref_id=None,
        message="",
    )


def _passing_inputs() -> tuple[
    Script, EditPlan, list[SegContext], TranscriptContext, list[Word], list[Segment]
]:
    block = _block(text="Export the PDF", target_min=1.0, target_max=2.0, est_dur=2.5)
    words = [
        Word(w="Export", start=0.2, end=0.8),
        Word(w="the", start=0.8, end=1.2),
        Word(w="PDF", start=1.2, end=1.8),
    ]
    return (
        Script(blocks=[block]),
        EditPlan(entries=[_entry(src=(0.0, 4.0), action="speed", speed=2.0, freeze_s=0.5)]),
        [_ctx("s1", ["Export"])],
        TranscriptContext(steps=[], key_terms=["PDF"], drops=[]),
        words,
        [_seg("s1", active=True)],
    )


def test_recheck_recomputes_every_check_and_drops_stale_script_results() -> None:
    script, plan, contexts, transcript, words, segments = _passing_inputs()
    fresh = recheck(script, plan, contexts, transcript, words, segments, 10.0, "original", 2.0)
    assert [c.name for c in fresh] == [
        "length_fit",
        "key_terms_kept",
        "coverage_order",
        "nothing_invented",
        "clean_only",
        "edl_valid",
        "edl_covers_script",
        "fix_options_respected",
    ]
    assert all(c.passed for c in fresh)

    # 3 words / 2 wps = 1.5s, still inside 1..2. "99" is in neither the span transcript nor screen text.
    invented = script.model_copy(update={"blocks": [_block(text="Export 99 PDF", est_dur=2.5)]})
    again = recheck(invented, plan, contexts, transcript, words, segments, 10.0, "ai", 2.0)
    by_name = {c.name: c for c in again}
    assert set(by_name) == {c.name for c in fresh}
    assert by_name["nothing_invented"].passed is False
    assert by_name["nothing_invented"].message == "b1: invented 99"
    assert by_name["length_fit"].passed is True
    assert by_name["clean_only"].passed is True


def test_user_edit_is_not_rejected_by_agent_fix_options() -> None:
    script, plan, contexts, transcript, words, segments = _passing_inputs()
    checks = recheck(
        script,
        plan,
        contexts,
        transcript,
        words,
        segments,
        10.0,
        "original",
        2.0,
        FixOptions(slow_parts=False),
        "user",
    )

    assert next(check for check in checks if check.name == "fix_options_respected").passed is True


def _option_state(
    *, fix_options: FixOptions, action: str = "speed", segment_active: bool = True
) -> AgentState:
    segment = _seg("s1", active=segment_active)
    pre = PreprocessResult(
        mezz_uri="gs://b/m.mp4",
        audio_uri="gs://b/a.wav",
        duration=4.0,
        fps=1.0,
        width=8,
        height=8,
        words=[Word(w="um", start=0.2, end=0.4)],
        keyframes=[],
        segments=[segment],
    )
    return AgentState(
        run_id="run-1",
        mode="review",
        voice="original",
        voice_wps=2.0,
        pre=pre,
        fix_options=fix_options,
        transcript_ctx=TranscriptContext(
            steps=[], key_terms=[], drops=[Drop(span=(0.2, 0.4), kind="filler", reason="filler")]
        ),
        edit_plan=EditPlan(entries=[_entry(action=action, speed=1.5)]),
    )


def test_fix_options_check_rejects_speed_when_slow_parts_are_disabled() -> None:
    result = fix_options_respected(_option_state(fix_options=FixOptions(slow_parts=False)))

    assert result.passed is False
    assert result.target == "video_editor"
    assert "Speed-ups are turned off" in result.message


def test_fix_options_check_allows_speed_when_slow_parts_are_enabled() -> None:
    result = fix_options_respected(_option_state(fix_options=FixOptions(slow_parts=True)))

    assert result.passed is True


def test_fix_options_check_rejects_cutting_an_idle_segment_when_pauses_are_disabled() -> None:
    result = fix_options_respected(
        _option_state(fix_options=FixOptions(pauses=False), action="cut", segment_active=False)
    )

    assert result.passed is False
    assert result.target == "video_editor"
    assert "Removing long pauses is off" in result.message
