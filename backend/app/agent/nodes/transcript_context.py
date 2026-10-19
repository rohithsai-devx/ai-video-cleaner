"""One structured call over the timed words."""

import json
from typing import Any

from langgraph.runtime import Runtime

from app.agent.prompts import TRANSCRIPT_CONTEXT
from app.agent.state import Ctx, make_call
from app.contracts.pipeline import AgentState, TranscriptContext


def transcript_context(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    words = json.dumps([word.model_dump(mode="json") for word in state.pre.words])
    ctx = runtime.context.bundle.complete(
        make_call(runtime.context.workspace_id, state.run_id, "transcript_context"),
        [
            {"role": "system", "content": TRANSCRIPT_CONTEXT},
            {"role": "user", "content": words},
        ],
        TranscriptContext,
    )
    return {"transcript_ctx": ctx}
