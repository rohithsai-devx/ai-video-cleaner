"""Proposal versions, user edits and approval.

Review lives outside the agent graph. The caller locks the run first.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb
from pydantic import BaseModel

from app.contracts.pipeline import CheckResult, EditPlan, Proposal, Script, SegContext, TranscriptContext
from app.runs.checks import edl_valid, recheck
from app.runs.exceptions import EditNotAllowed as EditNotAllowed
from app.runs.exceptions import InvalidEdl as InvalidEdl
from app.runs.exceptions import NoProposal as NoProposal
from app.runs.exceptions import NotReviewable as NotReviewable
from app.runs.exceptions import VersionConflict as VersionConflict
from app.runs.lifecycle import Event, RunRef, advance, load
from app.runs.schemas import ProposalUpdate
from app.shared.db import Conn


@dataclass(frozen=True)
class Keyframe:
    frame_id: str
    t: float
    uri: str  # gs:// URI; only signed URLs leave the server


def _to_proposal(row: dict[str, Any]) -> Proposal:
    return Proposal(
        run_id=str(row["run_id"]),
        version=row["version"],
        source=row["source"],
        script=Script.model_validate(row["script"]),
        edit_plan=EditPlan.model_validate(row["edit_plan"]),
        seg_contexts=[SegContext.model_validate(s) for s in row["seg_contexts"]],
        transcript_ctx=TranscriptContext.model_validate(row["transcript_ctx"]),
        checks=[CheckResult.model_validate(c) for c in row["checks"]],
        flags=list(row["flags"] or []),
    )


async def latest(conn: Conn, run: RunRef) -> tuple[UUID, Proposal] | None:
    cur = await conn.execute(
        "select p.*, r.flags from proposals p join runs r on r.id = p.run_id"
        " where p.run_id = %s order by p.version desc limit 1",
        (run.id,),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    return row["id"], _to_proposal(row)


async def keyframes(conn: Conn, run: RunRef) -> list[Keyframe]:
    cur = await conn.execute("select pre from runs where id = %s", (run.id,))
    row = await cur.fetchone()
    pre = (row or {}).get("pre") or {}
    return [
        Keyframe(frame_id=k["frame_id"], t=float(k["t"]), uri=k["uri"])
        for k in pre.get("keyframes", [])
        if k.get("uri")
    ]


async def read(conn: Conn, run_id: UUID) -> tuple[Proposal, list[Keyframe]] | None:
    """Latest proposal and its keyframes. None if the run is invisible; NoProposal if it has none yet."""
    run = await load(conn, run_id, for_update=False)
    if run is None:
        return None
    found = await latest(conn, run)
    if found is None:
        raise NoProposal("run has no proposal yet")
    return found[1], await keyframes(conn, run)


def _keyed_diff[T: BaseModel](
    path: str, old: list[T], new: list[T], key: Callable[[T], str], editable: set[str]
) -> list[str]:
    """Same keys, and only ``editable`` fields may differ. Returns the offending field paths."""
    old_by = {key(x): x for x in old}
    new_by = {key(x): x for x in new}
    if len(old_by) != len(old) or len(new_by) != len(new) or old_by.keys() != new_by.keys():
        return [f"{path} ids"]
    bad: list[str] = []
    for k, n in new_by.items():
        before = old_by[k].model_dump(mode="json", exclude=editable)
        after = n.model_dump(mode="json", exclude=editable)
        bad.extend(f"{path}[{k}].{f}" for f in before if before[f] != after[f])
    return bad


def _check_trust(old: Proposal, new: ProposalUpdate) -> None:
    """A user may change only script block text, EDL action/speed/freeze_s and must_keep; ids must match."""
    bad = _keyed_diff("script.blocks", old.script.blocks, new.script.blocks, lambda b: b.block_id, {"text"})
    bad += _keyed_diff(
        "edit_plan.entries",
        old.edit_plan.entries,
        new.edit_plan.entries,
        lambda e: e.seg_id,
        {"action", "speed", "freeze_s"},
    )
    bad += _keyed_diff("seg_contexts", old.seg_contexts, new.seg_contexts, lambda s: s.seg_id, {"must_keep"})
    if old.script.model_dump(mode="json", exclude={"blocks"}) != new.script.model_dump(
        mode="json", exclude={"blocks"}
    ):
        bad.append("script")
    if old.edit_plan.model_dump(mode="json", exclude={"entries"}) != new.edit_plan.model_dump(
        mode="json", exclude={"entries"}
    ):
        bad.append("edit_plan")
    if bad:
        raise EditNotAllowed("edit changes fields outside the trust rule: " + ", ".join(bad))


def _review_edits(old: Proposal, new: ProposalUpdate) -> list[tuple[str, str, Any, Any]]:
    """(kind, target_id, agent_value, user_value) for each change, against the previous version."""
    edits: list[tuple[str, str, Any, Any]] = []
    old_blocks = {b.block_id: b.text for b in old.script.blocks}
    for b in new.script.blocks:
        if old_blocks.get(b.block_id) != b.text:
            edits.append(("block_text", b.block_id, old_blocks.get(b.block_id), b.text))
    old_entries = {e.seg_id: e for e in old.edit_plan.entries}
    for e in new.edit_plan.entries:
        prev = old_entries.get(e.seg_id)
        if prev is None or (prev.action == "cut") != (e.action == "cut"):
            edits.append(("cut_toggle", e.seg_id, prev.action if prev else None, e.action))
        if prev is None or prev.speed != e.speed:
            edits.append(("speed", e.seg_id, prev.speed if prev else None, e.speed))
    old_keep = {s.seg_id: s.must_keep for s in old.seg_contexts}
    for s in new.seg_contexts:
        if old_keep.get(s.seg_id) != s.must_keep:
            edits.append(("must_keep", s.seg_id, old_keep.get(s.seg_id), s.must_keep))
    return edits


def _check_base(base_version: int | None, latest_: Proposal) -> None:
    """Compare-and-set on the version. Safe without a race window: the caller holds the run row lock."""
    if base_version is not None and base_version != latest_.version:
        raise VersionConflict(base_version, latest_.version)


async def save_edit(conn: Conn, run: RunRef, update: ProposalUpdate) -> Proposal:
    """Write version n+1 (source='user') after the trust rule passes. The run must be locked."""
    if run.status != "awaiting_review":
        raise NotReviewable(f"run is {run.status}, not awaiting_review")
    found = await latest(conn, run)
    if found is None:
        raise NoProposal("run has no proposal yet")
    _, old = found
    _check_base(update.base_version, old)
    _check_trust(old, update)
    # the EDL check always uses the stored seg_contexts
    checks = recheck(old.checks, update.edit_plan, old.seg_contexts, run.duration_s)
    new = old.model_copy(
        update={
            "version": old.version + 1,  # safe: the run row is locked
            "source": "user",
            "script": update.script,
            "edit_plan": update.edit_plan,
            "seg_contexts": update.seg_contexts,
            "checks": checks,
        }
    )
    cur = await conn.execute(
        "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
        " seg_contexts, transcript_ctx, checks) values (%s, %s, %s, 'user', %s, %s, %s, %s, %s)"
        " returning id",
        (
            run.workspace_id,
            run.id,
            new.version,
            Jsonb(update.script.model_dump(mode="json")),
            Jsonb(update.edit_plan.model_dump(mode="json")),
            Jsonb([s.model_dump(mode="json") for s in update.seg_contexts]),
            Jsonb(old.transcript_ctx.model_dump(mode="json")),
            Jsonb([c.model_dump(mode="json") for c in checks]),
        ),
    )
    row = await cur.fetchone()
    assert row is not None
    edits = _review_edits(old, update)
    if edits:
        async with conn.cursor() as c:
            await c.executemany(
                "insert into review_edits (workspace_id, proposal_id, user_id, kind, target_id,"
                " agent_value, user_value) values (%s, %s, app.uid(), %s, %s, %s, %s)",
                [(run.workspace_id, row["id"], k, t, Jsonb(a), Jsonb(u)) for k, t, a, u in edits],
            )
    return new


async def approve(conn: Conn, run: RunRef, base_version: int | None = None) -> list[Event]:
    """EDL-check the latest version, record the approval, advance to approved (enqueues post-io).

    With ``base_version``, the latest version must be that one. The run must be locked.
    """
    if run.status != "awaiting_review":
        raise NotReviewable(f"run is {run.status}, not awaiting_review")
    found = await latest(conn, run)
    if found is None:
        raise NoProposal("run has no proposal yet")
    pid, proposal = found
    _check_base(base_version, proposal)
    check = edl_valid(proposal.edit_plan, proposal.seg_contexts, run.duration_s)
    if not check.passed:
        raise InvalidEdl(check)
    await conn.execute(
        "update proposals set approved_by = app.uid(), approved_at = now() where id = %s", (pid,)
    )
    return await advance(conn, run, "approved")
