"""LangGraph agent. The graph returns a proposal; it does not write run status.

Invoke with the preprocess result. A redelivery invokes again with no input on the same thread.
Durability is sync. App callers pass a MemorySaver; the Studio export leaves checkpointing to the API.
"""

from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.graph import START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import RetryPolicy

from app.agent.nodes.orchestrator import orchestrator
from app.agent.nodes.script_writer import script_writer
from app.agent.nodes.transcript_context import transcript_context
from app.agent.nodes.video_editor import video_editor
from app.agent.nodes.vlm_context import vlm_context
from app.agent.state import Bundle, Ctx
from app.contracts.enums import RunMode, VoiceMode
from app.contracts.pipeline import (
    AgentState,
    CheckResult,
    Drop,
    EditPlan,
    EDLEntry,
    FixOptions,
    Keyframe,
    PreprocessResult,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    Step,
    TranscriptContext,
    Word,
)
from app.providers.errors import ProviderError
from app.runs.checks import VOICE_WPS

_CHECKPOINT_TYPES = (
    AgentState,
    PreprocessResult,
    Word,
    Keyframe,
    Segment,
    SegContext,
    TranscriptContext,
    Step,
    Drop,
    Script,
    ScriptBlock,
    EditPlan,
    EDLEntry,
    FixOptions,
    CheckResult,
)


def _retryable(exc: Exception) -> bool:
    return isinstance(exc, ProviderError) and exc.retryable


_RETRY = RetryPolicy(
    initial_interval=0.0,
    backoff_factor=1.0,
    max_interval=0.0,
    max_attempts=3,
    jitter=False,
    retry_on=_retryable,
)


def checkpointer() -> MemorySaver:
    # Without the allowlist, restoring these models warns and a later LangGraph will refuse them.
    return MemorySaver(serde=JsonPlusSerializer(allowed_msgpack_modules=list(_CHECKPOINT_TYPES)))


def build_graph(saver: MemorySaver | None = None) -> CompiledStateGraph[Any, Any, Any, Any]:
    builder = StateGraph(AgentState, context_schema=Ctx)
    builder.add_node("orchestrator", orchestrator)
    builder.add_node("vlm_context", vlm_context, retry_policy=_RETRY)
    builder.add_node("transcript_context", transcript_context, retry_policy=_RETRY)
    builder.add_node("script_writer", script_writer, retry_policy=_RETRY)
    builder.add_node("video_editor", video_editor, retry_policy=_RETRY)
    builder.add_edge(START, "orchestrator")
    for name in ("vlm_context", "transcript_context", "script_writer", "video_editor"):
        builder.add_edge(name, "orchestrator")
    if saver is None:
        return builder.compile()
    return builder.compile(checkpointer=saver)


class _Run(Protocol):
    @property
    def id(self) -> UUID: ...

    @property
    def mode(self) -> RunMode: ...


def initial_state(
    run: _Run,
    pre: PreprocessResult,
    *,
    voice: VoiceMode = "original",
    fix_options: FixOptions | None = None,
) -> AgentState:
    return AgentState(
        run_id=str(run.id),
        mode=run.mode,
        voice=voice,
        voice_wps=VOICE_WPS,
        pre=pre,
        fix_options=fix_options or FixOptions(),
    )


def invoke(
    graph: CompiledStateGraph[Any, Any, Any, Any],
    state: AgentState | None,
    bundle: Bundle,
    *,
    thread_id: str,
    workspace_id: str,
    interrupt_after: list[str] | None = None,
) -> dict[str, Any]:
    raw = graph.invoke(
        state,
        {"configurable": {"thread_id": thread_id}},
        context=Ctx(bundle=bundle, workspace_id=workspace_id),
        durability="sync",
        interrupt_after=interrupt_after,
    )
    if not isinstance(raw, dict):
        raise RuntimeError("the graph did not return a state")
    return raw


@dataclass(frozen=True)
class Draft:
    """What the graph hands the stage. ``accepted`` is false when the attempt cap ended the run."""

    script: Script
    edit_plan: EditPlan
    seg_contexts: list[SegContext]
    transcript_ctx: TranscriptContext
    checks: list[CheckResult]
    flags: list[str]
    accepted: bool


def to_output(raw: dict[str, Any]) -> Draft:
    state = AgentState.model_validate(raw)
    if state.script is None or state.transcript_ctx is None:
        raise RuntimeError("the agent ended without a script")
    if state.edit_plan is None or not state.edit_plan.entries:
        raise RuntimeError("the agent ended without a renderable edit plan")
    return Draft(
        script=state.script,
        edit_plan=state.edit_plan,
        seg_contexts=list(state.seg_contexts),
        transcript_ctx=state.transcript_ctx,
        checks=list(state.checks),
        flags=list(state.flags),
        accepted=state.stage == "done",
    )


graph = build_graph()
