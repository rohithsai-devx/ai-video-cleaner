"""One structured call that writes the edit plan. Frame scores come from the recording."""

import json
from typing import Any

from langgraph.runtime import Runtime

from app.agent.prompts import VIDEO_EDITOR
from app.agent.state import Ctx, make_call
from app.agent.tools.compare_frames import compare_frames
from app.contracts.pipeline import AgentState, EditPlan
from app.runs.checks import MAX_SPEED


def video_editor(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    # complete() returns the schema, so the node reads scores itself. A tool-call loop waits on a
    # client that can hand tool calls back; the scores travel in the body, so no tool is offered.
    scores = compare_frames(state.pre.keyframes)
    body = {
        "script": None if state.script is None else state.script.model_dump(mode="json"),
        "feedback": state.feedback.get("video_editor", []),
        "frames": scores,
    }
    plan = runtime.context.bundle.complete(
        make_call(runtime.context.workspace_id, state.run_id, "video_editor"),
        [
            {"role": "system", "content": VIDEO_EDITOR.format(max_speed=MAX_SPEED)},
            {"role": "user", "content": json.dumps(body)},
        ],
        EditPlan,
    )
    return {"edit_plan": plan}
