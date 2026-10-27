"""Pure projection of the agent's original edits and whether the latest version undid them."""

from app.contracts.pipeline import Change, Proposal
from app.runs.checks import plain_copy

_FALLBACK = {
    "pause": "A long pause was removed.",
    "filler": "A filler word was removed.",
    "retake": "A retake was removed.",
    "cut": "This part was cut.",
    "speed": "A slow part was sped up.",
    "hold": "The last frame was held.",
}


def changes(agent_v1: Proposal, latest: Proposal) -> list[Change]:
    contexts = {context.seg_id: context for context in agent_v1.seg_contexts}
    latest_entries = {entry.seg_id: entry for entry in latest.edit_plan.entries}
    result: list[Change] = []

    for entry in agent_v1.edit_plan.entries:
        if entry.action == "keep" and entry.freeze_s <= 0:
            continue
        overlapping_drop = next(
            (
                drop
                for drop in agent_v1.transcript_ctx.drops
                if max(entry.src[0], drop.span[0]) < min(entry.src[1], drop.span[1])
            ),
            None,
        )
        if entry.action == "speed":
            kind = "speed"
        elif entry.freeze_s > 0:
            kind = "hold"
        elif entry.action == "cut":
            if overlapping_drop is not None and overlapping_drop.kind == "filler":
                kind = "filler"
            elif overlapping_drop is not None and overlapping_drop.kind in ("false_start", "retake"):
                kind = "retake"
            elif contexts.get(entry.seg_id) is not None and contexts[entry.seg_id].by == "code":
                kind = "pause"
            else:
                kind = "cut"
        else:
            continue

        current = latest_entries.get(entry.seg_id)
        result.append(
            Change(
                change_id=entry.seg_id,
                kind=kind,
                span=entry.src,
                speed=entry.speed if kind == "speed" else None,
                hold_s=entry.freeze_s if kind == "hold" else None,
                reason=plain_copy(
                    overlapping_drop.reason if overlapping_drop is not None else entry.reasoning,
                    _FALLBACK[kind],
                ),
                undone=current is not None and current.action == "keep" and current.freeze_s == 0,
            )
        )
    return result
