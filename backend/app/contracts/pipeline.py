"""Models for the worker, the agent graph and the persisted proposal.

Mirrors "Schema: Pydantic models" in docs/design/hld-lld.md. Runtime-only Ctx and Providers
are not here: they hold live clients, so they never cross a boundary.
"""

from collections.abc import Callable
from operator import add
from typing import Annotated, Any, Literal

from pydantic import BaseModel, model_validator

from app.contracts.enums import ProposalSource, RunMode, VoiceMode

Span = tuple[float, float]  # (start_s, end_s) on the source timeline


def timeline_duration(span: Span, speed: float, freeze_s: float = 0.0) -> float:
    """Kept screen duration after speed and hold."""
    if speed <= 0:
        return 0.0
    return (span[1] - span[0]) / speed + freeze_s


class FixOptions(BaseModel):
    pauses: bool = True
    filler: bool = True
    retakes: bool = True
    slow_parts: bool = True


# ---------- preprocessing output ----------


class Word(BaseModel):
    w: str
    start: float
    end: float


class Keyframe(BaseModel):
    frame_id: str
    t: float
    uri: str
    diff: float


class Segment(BaseModel):
    seg_id: str
    start: float
    end: float
    frame_ids: list[str]
    active: bool


class PreprocessResult(BaseModel):
    mezz_uri: str
    audio_uri: str
    duration: float
    fps: float
    width: int
    height: int
    words: list[Word]
    keyframes: list[Keyframe]
    segments: list[Segment]


# ---------- subagent outputs ----------


class SegContext(BaseModel):  # vlm_context, one per segment
    seg_id: str
    label: str  # free text, e.g. "waiting for report export"
    reasoning: str  # shown in review UI
    cuttable: bool
    min_dur: float
    max_dur: float
    max_speed: float
    must_keep: list[Span] = []
    screen_text: list[str] = []  # visible UI labels, feeds 'nothing invented'
    by: Literal["code", "vlm"]  # 'code' = idle shortcut


class Drop(BaseModel):
    span: Span
    kind: Literal["filler", "false_start", "retake"]
    reason: str


class Step(BaseModel):
    step_id: str
    summary: str
    span: Span
    title: str = ""


class Chapter(BaseModel):
    title: str
    start: float
    end: float


class ScriptLine(BaseModel):
    block_id: str
    text: str
    start: float
    end: float
    overflow_s: float


ChangeKind = Literal["pause", "filler", "retake", "cut", "speed", "hold"]


class Change(BaseModel):
    change_id: str
    kind: ChangeKind
    span: Span
    speed: float | None = None
    hold_s: float | None = None
    reason: str
    undone: bool


class TranscriptContext(BaseModel):  # transcript_context
    steps: list[Step]
    key_terms: list[str]
    drops: list[Drop]


class ScriptBlock(BaseModel):
    block_id: str
    text: str
    seg_ids: list[str]
    source_span: Span  # where the words came from
    target_min: float  # from the segments' min/max_dur
    target_max: float
    est_dur: float  # words / voice wps


class Script(BaseModel):
    style: Literal["clean"] = "clean"
    blocks: list[ScriptBlock]


class EDLEntry(BaseModel):
    seg_id: str
    src: Span
    action: Literal["keep", "cut", "speed", "freeze"]
    speed: float = 1.0
    freeze_s: float = 0.0
    block_id: str | None = None
    reasoning: str


class EDLEntryPatch(BaseModel):
    seg_id: str
    action: Literal["keep", "cut", "speed", "freeze"]
    speed: float = 1.0
    freeze_s: float = 0.0


class BlockPatch(BaseModel):
    block_id: str
    text: str


class FixPatch(BaseModel):
    entry: EDLEntryPatch | None = None
    block: BlockPatch | None = None

    @model_validator(mode="after")
    def _one_target(self) -> "FixPatch":
        if (self.entry is None) == (self.block is None):
            raise ValueError("a fix patch must contain exactly one target")
        return self


class Fix(BaseModel):
    fix_id: str
    label: str
    patch: FixPatch


class Spot(BaseModel):
    spot_id: str
    span: Span
    question: str
    fixes: list[Fix]
    chosen_fix_id: str | None = None
    chosen_by: Literal["user", "default"] | None = None


class EditPlan(BaseModel):  # video_editor
    entries: list[EDLEntry]


# ---------- orchestrator ----------

Agent = Literal["transcript_context", "script_writer", "video_editor", "spot_writer"]


class CheckResult(BaseModel):
    name: str
    passed: bool
    target: Agent
    message: str = ""
    ref_id: str | None = None  # block_id / seg_id for UI highlight


def merge_by(key: str) -> Callable[[list[Any], list[Any]], list[Any]]:
    """Reducer: insert or replace by id, keeping the first-seen position."""

    def _merge(left: list[Any], right: list[Any]) -> list[Any]:
        out: dict[Any, Any] = {getattr(x, key): x for x in left}
        out.update({getattr(x, key): x for x in right})
        return list(out.values())

    return _merge


class AgentState(BaseModel):  # LangGraph state (thread_id = run_id)
    run_id: str
    mode: RunMode
    voice: VoiceMode
    voice_wps: float  # measured words/sec of chosen voice
    pre: PreprocessResult
    fix_options: FixOptions = FixOptions()
    seg_contexts: Annotated[list[SegContext], merge_by("seg_id")] = []
    transcript_ctx: TranscriptContext | None = None
    script: Script | None = None
    edit_plan: EditPlan | None = None
    spots: list[Spot] = []
    stage: Literal["context", "script", "edit", "done"] = "context"
    feedback: dict[str, list[str]] = {}
    attempts: dict[str, int] = {}
    checks: list[CheckResult] = []
    flags: Annotated[list[str], add] = []


# ---------- persisted proposal (proposals row) ----------


class Proposal(BaseModel):
    run_id: str
    version: int
    source: ProposalSource
    script: Script
    edit_plan: EditPlan
    seg_contexts: list[SegContext]
    transcript_ctx: TranscriptContext
    checks: list[CheckResult]
    flags: list[str]
    spots: list[Spot] = []


__all__ = [
    "Agent",
    "AgentState",
    "Change",
    "ChangeKind",
    "Chapter",
    "CheckResult",
    "Drop",
    "BlockPatch",
    "EDLEntry",
    "EDLEntryPatch",
    "EditPlan",
    "Fix",
    "FixPatch",
    "FixOptions",
    "Keyframe",
    "PreprocessResult",
    "Proposal",
    "Script",
    "ScriptBlock",
    "ScriptLine",
    "SegContext",
    "Segment",
    "Spot",
    "Span",
    "Step",
    "TranscriptContext",
    "Word",
    "merge_by",
    "timeline_duration",
]
