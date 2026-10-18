"""Checks the LangGraph assumptions the design doc relies on."""
from typing import Annotated, Literal
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command
from langgraph.checkpoint.memory import InMemorySaver


def merge_by(key):
    def reducer(old, new):
        out = {getattr(x, key): x for x in old or []}
        for x in new or []:
            out[getattr(x, key)] = x
        return list(out.values())
    return reducer


class SegContext(BaseModel):
    seg_id: str
    label: str


class AgentState(BaseModel):
    seg_contexts: Annotated[list[SegContext], merge_by("seg_id")] = Field(default_factory=list)
    flags: Annotated[list[str], lambda a, b: a + b] = Field(default_factory=list)
    attempts: int = 0
    log: Annotated[list[str], lambda a, b: a + b] = Field(default_factory=list)


def orchestrator(s: AgentState) -> Command[Literal["vlm_context", "transcript_context", "__end__"]]:
    if s.attempts == 0:
        return Command(update={"attempts": 1}, goto=["vlm_context", "transcript_context"])  # parallel fan-out
    if s.attempts == 1:
        return Command(update={"attempts": 2}, goto="vlm_context")                          # redo one subagent
    return Command(goto=END)


def vlm_context(s: AgentState) -> Command[Literal["orchestrator"]]:
    label = "first" if s.attempts == 1 else "redo"
    return Command(update={"seg_contexts": [SegContext(seg_id="s1", label=label), SegContext(seg_id="s2", label=label)],
                           "log": [f"vlm@{s.attempts}"]}, goto="orchestrator")


def transcript_context(s: AgentState) -> Command[Literal["orchestrator"]]:
    return Command(update={"flags": ["t"], "log": [f"tx@{s.attempts}"]}, goto="orchestrator")


b = StateGraph(AgentState)
b.add_node("orchestrator", orchestrator)
b.add_node("vlm_context", vlm_context)
b.add_node("transcript_context", transcript_context)
b.add_edge(START, "orchestrator")
g = b.compile(checkpointer=InMemorySaver())

out = g.invoke(AgentState(), {"configurable": {"thread_id": "t1"}}, durability="sync")
print("output type:", type(out).__name__)
print("log:", out["log"])
print("seg_contexts:", [(c.seg_id, c.label) for c in out["seg_contexts"]], "item type:", type(out["seg_contexts"][0]).__name__)
assert out["log"][:2] in (["vlm@1", "tx@1"], ["tx@1", "vlm@1"]), "fan-out did not run both in one superstep"
assert [(c.seg_id, c.label) for c in out["seg_contexts"]] == [("s1", "redo"), ("s2", "redo")], "merge_by did not replace"
for mode in ("async", "exit"):
    g.invoke(AgentState(), {"configurable": {"thread_id": f"t-{mode}"}}, durability=mode)
try:
    AgentState(attempts="not-an-int")
except Exception as e:
    print("input validation:", type(e).__name__)
print("ALL CHECKS PASSED")
