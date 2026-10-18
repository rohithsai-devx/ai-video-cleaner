"""Worked examples for the phase 3a pure functions.

Expected numbers are the table and the segment example in
.coding-powers/specs/phase3a.md. Nothing else is asserted as a result.
"""

from uuid import UUID

from app.contracts.pipeline import EDLEntry, Keyframe, PreprocessResult, SegContext, Segment
from app.pipeline.proposal_stub import stub_proposal
from app.pipeline.segment import segment
from app.pipeline.timeline import fit_timeline
from app.pipeline.words import stub_words
from app.runs.checks import edl_valid
from app.runs.lifecycle import RunRef

# span, min, cuttable, audio, narration, src end, speed, freeze
_FIT = [
    (10, 2, True, 4, False, 4, 1, 0),
    (4, 2, True, 7, False, 4, 1, 3),
    (10, 6, True, 4, False, 6, 1.5, 0),
    (4, 4, False, 1, False, 4, 2, 0),
    (10, 6, True, 4, True, 6, 1, 0),
]

_RUN = RunRef(
    id=UUID("00000000-0000-4000-8000-000000000001"),
    workspace_id=UUID("00000000-0000-4000-8000-000000000002"),
    video_id=UUID("00000000-0000-4000-8000-000000000003"),
    status="queued",
    stage=None,
    attempt=1,
    mode="review",
    duration_s=5.0,
)


def _ctx(min_dur: float, *, cuttable: bool, span: float) -> SegContext:
    return SegContext(
        seg_id="s",
        label="s",
        reasoning="",
        cuttable=cuttable,
        min_dur=float(min_dur),
        max_dur=float(span),
        max_speed=2,
        by="code",
    )


def _keep(span: float, *, block_id: str | None = "b") -> EDLEntry:
    return EDLEntry(
        seg_id="s",
        src=(0.0, float(span)),
        action="keep",
        block_id=block_id,
        reasoning="kept",
    )


def test_fit_timeline_worked_table() -> None:
    for span, min_dur, cuttable, audio, narration, src_end, speed, freeze in _FIT:
        ctx = _ctx(min_dur, cuttable=cuttable, span=span)
        [out] = fit_timeline([_keep(span)], [ctx], {"b": float(audio)}, narration=narration)
        assert out.src == (0.0, float(src_end))
        assert out.speed == speed
        assert out.freeze_s == freeze
        assert out.speed <= ctx.max_speed
        assert out.speed <= 2
        if narration:
            assert out.speed == 1


def test_fit_timeline_copies_cuts_and_entries_without_a_block() -> None:
    ctx = _ctx(2, cuttable=True, span=10)
    cut = EDLEntry(seg_id="s", src=(0.0, 10.0), action="cut", block_id="b", reasoning="drop")
    bare = _keep(10, block_id=None)
    fitted = fit_timeline([cut, bare], [ctx], {"b": 4.0}, narration=False)
    assert fitted == [cut, bare]


def test_segment_worked_example() -> None:
    frames = [
        Keyframe(frame_id="f0", t=0, uri="f", diff=0),
        Keyframe(frame_id="f1", t=1, uri="f", diff=0.1),
        Keyframe(frame_id="f2", t=2, uri="f", diff=0.9),
        Keyframe(frame_id="f3", t=3, uri="f", diff=0.1),
        Keyframe(frame_id="f4", t=4, uri="f", diff=0.1),
        Keyframe(frame_id="f5", t=5, uri="f", diff=0),
    ]
    segs = segment(frames, end_s=5)
    assert [(s.start, s.end, s.active) for s in segs] == [(0.0, 2.0, False), (2.0, 5.0, True)]
    # The frame at the cut belongs to the later segment, so the first stays inactive.
    assert [s.frame_ids for s in segs] == [["f0", "f1"], ["f2", "f3", "f4"]]


def test_stub_words_one_per_whole_second() -> None:
    assert [(w.w, w.start, w.end) for w in stub_words(3)] == [
        ("word", 0.0, 0.5),
        ("word", 1.0, 1.5),
        ("word", 2.0, 2.5),
    ]


def test_stub_words_under_one_second() -> None:
    assert [(w.w, w.start, w.end) for w in stub_words(0.4)] == [("word", 0.0, 0.4)]


def _pre(segments: list[Segment], duration: float) -> PreprocessResult:
    return PreprocessResult(
        mezz_uri="m",
        audio_uri="a",
        duration=duration,
        fps=1,
        width=1,
        height=1,
        words=stub_words(duration),
        keyframes=[],
        segments=segments,
    )


def test_stub_proposal_from_worked_segments() -> None:
    segments = [
        Segment(seg_id="seg_01", start=0.0, end=2.0, frame_ids=["f0", "f1"], active=False),
        Segment(seg_id="seg_02", start=2.0, end=5.0, frame_ids=["f2", "f3", "f4"], active=True),
    ]
    out = stub_proposal(_RUN, _pre(segments, 5))
    assert [(c.seg_id, c.by, c.cuttable, c.min_dur, c.max_dur, c.max_speed) for c in out.seg_contexts] == [
        ("seg_01", "code", False, 2, 2, 2),
        ("seg_02", "code", True, 2, 3, 2),
    ]
    assert len(out.script.blocks) == 1
    block = out.script.blocks[0]
    assert block.seg_ids == ["seg_01", "seg_02"]
    assert block.source_span == (0.0, 5.0)
    assert block.target_min == 4
    assert block.target_max == 5
    assert [(e.seg_id, e.src, e.action, e.speed, e.freeze_s) for e in out.edit_plan.entries] == [
        ("seg_01", (0.0, 2.0), "keep", 1, 0),
        ("seg_02", (2.0, 5.0), "keep", 1, 0),
    ]
    check = edl_valid(out.edit_plan, out.seg_contexts, 5)
    assert check.passed, check.message


def test_stub_proposal_empty_segments_cover_the_duration() -> None:
    out = stub_proposal(_RUN, _pre([], 5))
    assert len(out.seg_contexts) == 1
    ctx = out.seg_contexts[0]
    assert (ctx.by, ctx.cuttable, ctx.min_dur, ctx.max_dur, ctx.max_speed) == ("code", False, 2, 5, 2)
    assert len(out.script.blocks) == 1
    assert out.script.blocks[0].seg_ids == [ctx.seg_id]
    assert out.script.blocks[0].source_span == (0.0, 5.0)
    assert [(e.src, e.action, e.speed, e.freeze_s, e.seg_id) for e in out.edit_plan.entries] == [
        ((0.0, 5.0), "keep", 1, 0, ctx.seg_id)
    ]
    check = edl_valid(out.edit_plan, out.seg_contexts, 5)
    assert check.passed, check.message
