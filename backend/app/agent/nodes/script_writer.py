"""One structured call that writes the cleaned blocks."""

import json
from typing import Any

from langgraph.runtime import Runtime

from app.agent.prompts import SCRIPT_WRITER
from app.agent.state import Ctx, make_call
from app.contracts.pipeline import AgentState, Script


def script_writer(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    body = {
        "transcript": None if state.transcript_ctx is None else state.transcript_ctx.model_dump(mode="json"),
        "segments": [ctx.model_dump(mode="json") for ctx in state.seg_contexts],
        "feedback": state.feedback.get("script_writer", []),
    }
    script = runtime.context.bundle.complete(
        make_call(runtime.context.workspace_id, state.run_id, "script_writer"),
        [
            {"role": "system", "content": SCRIPT_WRITER.format(voice_wps=state.voice_wps)},
            {"role": "user", "content": json.dumps(body)},
        ],
        Script,
    )
    return {"script": script}
