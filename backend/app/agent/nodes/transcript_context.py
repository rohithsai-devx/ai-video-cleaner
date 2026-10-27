"""One structured call over the timed words."""

import json
from typing import Any

from langgraph.runtime import Runtime

from app.agent.prompts import TRANSCRIPT_CONTEXT
from app.agent.state import Ctx, make_call
from app.contracts.pipeline import AgentState, TranscriptContext


def transcript_context(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    allowed_drop_kinds = []
    if state.fix_options.filler:
        allowed_drop_kinds.append("filler")
    if state.fix_options.retakes:
        allowed_drop_kinds.extend(("false_start", "retake"))
    user_message = {
        "words": [word.model_dump(mode="json") for word in state.pre.words],
        "allowed_drop_kinds": allowed_drop_kinds,
        "feedback": state.feedback.get("transcript_context", []),
    }
    allowed_text = ", ".join(allowed_drop_kinds) or "none"
    ctx = runtime.context.bundle.complete(
        make_call(runtime.context.workspace_id, state.run_id, "transcript_context"),
        [
            {
                "role": "system",
                "content": TRANSCRIPT_CONTEXT.format(allowed_drop_kinds=allowed_text),
            },
            {"role": "user", "content": json.dumps(user_message)},
        ],
        TranscriptContext,
    )
    return {"transcript_ctx": ctx}
