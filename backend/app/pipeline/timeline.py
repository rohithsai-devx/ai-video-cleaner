"""Fit kept spans to measured audio. Cuts are copied. Narration is never sped up."""

from app.contracts.pipeline import EDLEntry, SegContext, timeline_duration
from app.runs.checks import MAX_SPEED


def fit_timeline(
    entries: list[EDLEntry],
    contexts: list[SegContext],
    audio_s_by_block: dict[str, float],
    *,
    narration: bool,
) -> list[EDLEntry]:
    by_seg = {ctx.seg_id: ctx for ctx in contexts}
    return [_fit(entry, by_seg.get(entry.seg_id), audio_s_by_block, narration) for entry in entries]


def _fit(
    entry: EDLEntry,
    ctx: SegContext | None,
    audio_s_by_block: dict[str, float],
    narration: bool,
) -> EDLEntry:
    if entry.action == "cut" or entry.block_id is None or ctx is None:
        return entry
    target = audio_s_by_block.get(entry.block_id)
    if target is None or target <= 0:
        return entry

    start, end = entry.src
    span = end - start
    if span > target and ctx.cuttable:
        span = min(span, max(ctx.min_dur, target))
        end = start + span

    speed = 1.0
    if span > target and not narration:
        capped = min(ctx.max_speed, MAX_SPEED, span / target)
        if capped > 0:
            speed = capped

    played = timeline_duration((start, end), speed)
    freeze = target - played if played < target else 0.0
    if speed != 1.0:
        action = "speed"
    elif freeze > 0:
        action = "freeze"
    else:
        action = "keep"
    return entry.model_copy(
        update={"src": (start, end), "speed": speed, "freeze_s": freeze, "action": action}
    )
