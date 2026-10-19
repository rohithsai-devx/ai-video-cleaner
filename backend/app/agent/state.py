"""Runtime context for the graph. It is not checkpointed."""

from dataclasses import dataclass
from typing import Any, Protocol

from app.contracts.pipeline import SegContext
from app.providers import Call


@dataclass(frozen=True)
class Decision:
    p_yes: float


@dataclass(frozen=True)
class Ctx:
    bundle: "Bundle"
    workspace_id: str
    accept_threshold: float = 0.7
    max_attempts: int = 3


class Bundle(Protocol):
    def complete(
        self, call: Call, messages: list[Any], schema: type[Any], tools: list[dict[str, Any]] | None = None
    ) -> Any: ...

    def describe(
        self, call: Call, frame_uris: list[str], transcript: str, hints: dict[str, Any]
    ) -> SegContext: ...

    def yes_no(self, call: Call, question: str, ctx: str) -> Decision: ...


def make_call(workspace_id: str, run_id: str, stage: str) -> Call:
    return Call(workspace_id=workspace_id, run_id=run_id, stage=stage)
