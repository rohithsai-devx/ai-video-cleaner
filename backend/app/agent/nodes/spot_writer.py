"""Turn checks the agent could not settle into concrete, user-editable choices."""

import json
from typing import Any
from uuid import uuid4

from langgraph.runtime import Runtime
from pydantic import BaseModel

from app.agent.prompts import SPOT_WRITER
from app.agent.state import Ctx, make_call
from app.contracts.pipeline import (
    AgentState,
    BlockPatch,
    EDLEntryPatch,
    Fix,
    FixPatch,
    Spot,
)
from app.runs.checks import MAX_SPEED, _contains_internal_copy


class FixIdea(BaseModel):
    label: str
    patch: FixPatch


class SpotIdea(BaseModel):
    span: tuple[float, float]
    question: str
    fixes: list[FixIdea]


class SpotIdeas(BaseModel):
    spots: list[SpotIdea]


def _valid_entry(entry: EDLEntryPatch, known: set[str]) -> bool:
    return entry.seg_id in known and 0 < entry.speed <= MAX_SPEED and entry.freeze_s >= 0


def _valid_block(block: BlockPatch, known: set[str]) -> bool:
    return block.block_id in known


def _spots(state: AgentState, ideas: SpotIdeas) -> list[Spot]:
    if state.script is None or state.edit_plan is None:
        return []
    seg_ids = {entry.seg_id for entry in state.edit_plan.entries}
    block_ids = {block.block_id for block in state.script.blocks}
    result: list[Spot] = []
    for idea in ideas.spots:
        if _contains_internal_copy(idea.question):
            continue
        fixes: list[Fix] = []
        for fix in idea.fixes:
            if _contains_internal_copy(fix.label):
                continue
            patch = fix.patch
            if patch.entry is not None and not _valid_entry(patch.entry, seg_ids):
                continue
            if patch.block is not None and not _valid_block(patch.block, block_ids):
                continue
            fixes.append(Fix(fix_id=str(uuid4()), label=fix.label, patch=patch))
        if not fixes:
            continue
        result.append(
            Spot(
                spot_id=str(uuid4()),
                span=idea.span,
                question=idea.question,
                fixes=fixes,
            )
        )
    return result


def spot_writer(state: AgentState, runtime: Runtime[Ctx]) -> dict[str, Any]:
    if state.script is None or state.edit_plan is None:
        return {"spots": []}
    body = {
        "failed_checks": [check.model_dump(mode="json") for check in state.checks if not check.passed],
        "script": state.script.model_dump(mode="json"),
        "edit_plan": state.edit_plan.model_dump(mode="json"),
        "segments": [{"seg_id": context.seg_id, "label": context.label} for context in state.seg_contexts],
    }
    ideas = runtime.context.bundle.complete(
        make_call(runtime.context.workspace_id, state.run_id, "spot_writer"),
        [
            {"role": "system", "content": SPOT_WRITER},
            {"role": "user", "content": json.dumps(body)},
        ],
        SpotIdeas,
    )
    return {"spots": _spots(state, ideas)}
