"""Pure projection of AI narration against the picture time retained for each script block."""

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import Proposal, ScriptLine, timeline_duration


def script_lines(proposal: Proposal, *, voice: VoiceMode) -> list[ScriptLine]:
    if voice != "ai":
        return []

    entries = {entry.seg_id: entry for entry in proposal.edit_plan.entries}
    result: list[ScriptLine] = []
    for block in proposal.script.blocks:
        kept = [
            entries[seg_id]
            for seg_id in block.seg_ids
            if seg_id in entries
            and entries[seg_id].block_id == block.block_id
            and entries[seg_id].action != "cut"
        ]
        start = kept[0].src[0] if kept else block.source_span[0]
        screen_s = sum(timeline_duration(entry.src, entry.speed, entry.freeze_s) for entry in kept)
        result.append(
            ScriptLine(
                block_id=block.block_id,
                text=block.text,
                start=start,
                end=start + block.est_dur,
                overflow_s=max(0.0, block.est_dur - screen_s),
            )
        )
    return result
