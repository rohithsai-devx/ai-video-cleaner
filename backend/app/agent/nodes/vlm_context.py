"""One describe per active segment. Inactive segments are labelled in code."""

from typing import Any

from langgraph.runtime import Runtime

from app.agent.state import Ctx, make_call
from app.contracts.pipeline import AgentState, SegContext
from app.runs.checks import MAX_SPEED


def vlm_context(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    frames = {frame.frame_id: frame.uri for frame in state.pre.keyframes}
    contexts: list[SegContext] = []
    for seg in state.pre.segments:
        if not seg.active:
            length = max(0.0, seg.end - seg.start)
            contexts.append(
                SegContext(
                    seg_id=seg.seg_id,
                    label="idle",
                    reasoning="Static.",
                    cuttable=True,
                    min_dur=length,
                    max_dur=length,
                    max_speed=MAX_SPEED,
                    by="code",
                )
            )
            continue
        uris = [frames[frame_id] for frame_id in seg.frame_ids if frame_id in frames]
        spoken = " ".join(word.w for word in state.pre.words if seg.start <= word.start < seg.end)
        described = runtime.context.bundle.describe(
            make_call(runtime.context.workspace_id, state.run_id, "vlm_context"),
            uris,
            spoken,
            {"seg_id": seg.seg_id, "start": seg.start, "end": seg.end},
        )
        contexts.append(described.model_copy(update={"seg_id": seg.seg_id, "by": "vlm"}))
    return {"seg_contexts": contexts}
