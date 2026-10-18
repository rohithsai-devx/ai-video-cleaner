"""Code-only proposal: one block over the scene segments, each kept at normal speed."""

from app.contracts.pipeline import (
    EditPlan,
    EDLEntry,
    PreprocessResult,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    TranscriptContext,
)
from app.pipeline.engines import AgentOutput
from app.runs.checks import MAX_SPEED, MIN_DUR, edl_valid
from app.runs.lifecycle import RunRef

_BLOCK = "b1"
_MIN_CAP = 2.0


def stub_proposal(run: RunRef, pre: PreprocessResult) -> AgentOutput:
    del run  # the stub reads the preprocess result; the run id is not part of the plan
    segments = list(pre.segments) or [_whole(pre.duration)]
    contexts = [_context(seg) for seg in segments]
    entries = [_keep(seg) for seg in segments]
    plan = EditPlan(entries=entries)
    start, end = segments[0].start, segments[-1].end
    block = ScriptBlock(
        block_id=_BLOCK,
        text=" ".join(word.w for word in pre.words),
        seg_ids=[seg.seg_id for seg in segments],
        source_span=(start, end),
        target_min=sum(ctx.min_dur for ctx in contexts),
        target_max=sum(ctx.max_dur for ctx in contexts),
        est_dur=end - start,
    )
    return AgentOutput(
        script=Script(blocks=[block]),
        edit_plan=plan,
        seg_contexts=contexts,
        transcript_ctx=TranscriptContext(steps=[], glossary=[], drops=[]),
        checks=[edl_valid(plan, contexts, pre.duration)],
        flags=[],
    )


def _whole(duration: float) -> Segment:
    return Segment(seg_id="seg_01", start=0.0, end=duration, frame_ids=[], active=False)


def _context(seg: Segment) -> SegContext:
    length = seg.end - seg.start
    return SegContext(
        seg_id=seg.seg_id,
        label="active" if seg.active else "idle",
        reasoning="Scene change." if seg.active else "Static.",
        cuttable=seg.active,
        min_dur=max(MIN_DUR, min(_MIN_CAP, length)),
        max_dur=length,
        max_speed=MAX_SPEED,
        by="code",
    )


def _keep(seg: Segment) -> EDLEntry:
    return EDLEntry(
        seg_id=seg.seg_id,
        src=(seg.start, seg.end),
        action="keep",
        speed=1.0,
        freeze_s=0.0,
        block_id=_BLOCK,
        reasoning="Kept at normal speed.",
    )
