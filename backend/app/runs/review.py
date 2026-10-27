"""Proposal versions, user edits and approval.

Review lives outside the agent graph. The caller locks the run first.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb
from pydantic import BaseModel

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import (
    CheckResult,
    EditPlan,
    FixOptions,
    Proposal,
    Script,
    SegContext,
    Segment,
    Spot,
    TranscriptContext,
    Word,
)
from app.runs.checks import VOICE_WPS, recheck
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
        spots=[Spot.model_validate(s) for s in (row.get("spots") or [])],
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


async def first_version(conn: Conn, run_id: UUID) -> Proposal | None:
    cur = await conn.execute(
        "select p.*, r.flags from proposals p join runs r on r.id = p.run_id"
        " where p.run_id = %s and p.version = 1",
        (run_id,),
    )
    row = await cur.fetchone()
    return None if row is None else _to_proposal(row)


async def chosen_fixes(conn: Conn, run_id: UUID) -> dict[str, tuple[str, str]]:
    cur = await conn.execute(
        "select distinct on (e.target_id) e.target_id, e.user_value"
        " from review_edits e join proposals p on p.id = e.proposal_id"
        " where p.run_id = %s and e.kind = 'fix_chosen'"
        " order by e.target_id, p.version desc, e.id desc",
        (run_id,),
    )
    rows = await cur.fetchall()
    return {
        str(row["target_id"]): (str(row["user_value"]["fix_id"]), str(row["user_value"].get("by", "user")))
        for row in rows
        if row["user_value"] and row["user_value"].get("fix_id")
    }


async def voice_mode(conn: Conn, run_id: UUID) -> VoiceMode | None:
    cur = await conn.execute("select voice from runs where id = %s", (run_id,))
    row = await cur.fetchone()
    return None if row is None else row["voice"]


async def peaks_uri(conn: Conn, run_id: UUID) -> str | None:
    cur = await conn.execute("select pre from runs where id = %s", (run_id,))
    row = await cur.fetchone()
    return ((row or {}).get("pre") or {}).get("peaks_uri")


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
    spots = {spot.spot_id: spot for spot in old.spots}
    for spot_id, fix_id in new.chosen_fixes.items():
        spot = spots.get(spot_id)
        if spot is None or fix_id not in {fix.fix_id for fix in spot.fixes}:
            raise EditNotAllowed("chosen_fixes contains an unknown spot or fix")
        edits.append(("fix_chosen", spot_id, None, {"fix_id": fix_id, "by": "user"}))
    return edits


def _stored_spots(spots: list[Spot]) -> list[Spot]:
    return [spot.model_copy(update={"chosen_fix_id": None, "chosen_by": None}) for spot in spots]


async def _write_fix_choices(
    conn: Conn,
    run: RunRef,
    proposal_id: UUID,
    choices: list[tuple[str, str, str]],
) -> None:
    if not choices:
        return
    async with conn.cursor() as cur:
        await cur.executemany(
            "insert into review_edits (workspace_id, proposal_id, user_id, kind, target_id,"
            " agent_value, user_value) values (%s, %s, app.uid(), 'fix_chosen', %s, null, %s)",
            [
                (run.workspace_id, proposal_id, spot_id, Jsonb({"fix_id": fix_id, "by": by}))
                for spot_id, fix_id, by in choices
            ],
        )


async def _check_inputs(conn: Conn, run: RunRef) -> tuple[VoiceMode, FixOptions, list[Word], list[Segment]]:
    """Voice, fix options and preprocess data the mechanical checks read."""
    cur = await conn.execute("select voice, fix_options, pre from runs where id = %s", (run.id,))
    row = await cur.fetchone()
    assert row is not None
    pre = row["pre"] or {}
    voice: VoiceMode = row["voice"]
    return (
        voice,
        FixOptions.model_validate(row["fix_options"] or {}),
        [Word.model_validate(w) for w in pre.get("words") or []],
        [Segment.model_validate(s) for s in pre.get("segments") or []],
    )


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
    voice, fix_options, words, segments = await _check_inputs(conn, run)
    checks = recheck(
        update.script,
        update.edit_plan,
        update.seg_contexts,
        old.transcript_ctx,
        words,
        segments,
        run.duration_s,
        voice,
        VOICE_WPS,
        fix_options,
        "user",
        for_review=True,
    )
    new = old.model_copy(
        update={
            "version": old.version + 1,  # safe: the run row is locked
            "source": "user",
            "script": update.script,
            "edit_plan": update.edit_plan,
            "seg_contexts": update.seg_contexts,
            "spots": _stored_spots(old.spots),
            "checks": checks,
        }
    )
    cur = await conn.execute(
        "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
        " seg_contexts, transcript_ctx, checks, spots)"
        " values (%s, %s, %s, 'user', %s, %s, %s, %s, %s, %s)"
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
            Jsonb([spot.model_dump(mode="json") for spot in new.spots]),
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
    """Re-check the latest version, record the approval, advance to approved (enqueues post-io).

    With ``base_version``, the latest version must be that one. The run must be locked.
    """
    if run.status != "awaiting_review":
        raise NotReviewable(f"run is {run.status}, not awaiting_review")
    found = await latest(conn, run)
    if found is None:
        raise NoProposal("run has no proposal yet")
    pid, proposal = found
    _check_base(base_version, proposal)
    voice, fix_options, words, segments = await _check_inputs(conn, run)
    choices = await chosen_fixes(conn, run.id)
    open_spots = [spot for spot in proposal.spots if not _valid_choice(spot, choices.get(spot.spot_id))]
    script = proposal.script
    edit_plan = proposal.edit_plan
    defaults: list[tuple[str, str, str]] = []
    if open_spots:
        script, edit_plan = _apply_default_fixes(proposal, open_spots)
        defaults = [(spot.spot_id, spot.fixes[0].fix_id, "default") for spot in open_spots]
    checks = recheck(
        script,
        edit_plan,
        proposal.seg_contexts,
        proposal.transcript_ctx,
        words,
        segments,
        run.duration_s,
        voice,
        VOICE_WPS,
        fix_options,
        "user" if open_spots else proposal.source,
        for_review=True,
    )
    failed = next(
        (check for check in checks if not check.passed),
        None,
    )
    if failed is not None:
        raise InvalidEdl(failed)
    if open_spots:
        updated = proposal.model_copy(
            update={
                "version": proposal.version + 1,
                "source": "user",
                "script": script,
                "edit_plan": edit_plan,
                "spots": _stored_spots(proposal.spots),
                "checks": checks,
            }
        )
        cur = await conn.execute(
            "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
            " seg_contexts, transcript_ctx, checks, spots)"
            " values (%s, %s, %s, 'user', %s, %s, %s, %s, %s, %s) returning id",
            (
                run.workspace_id,
                run.id,
                updated.version,
                Jsonb(updated.script.model_dump(mode="json")),
                Jsonb(updated.edit_plan.model_dump(mode="json")),
                Jsonb([item.model_dump(mode="json") for item in updated.seg_contexts]),
                Jsonb(updated.transcript_ctx.model_dump(mode="json")),
                Jsonb([item.model_dump(mode="json") for item in updated.checks]),
                Jsonb([spot.model_dump(mode="json") for spot in updated.spots]),
            ),
        )
        row = await cur.fetchone()
        assert row is not None
        pid = row["id"]
        await _write_fix_choices(conn, run, pid, defaults)
    await conn.execute(
        "update proposals set approved_by = app.uid(), approved_at = now() where id = %s", (pid,)
    )
    return await advance(conn, run, "approved", stage="approved")


def _valid_choice(spot: Spot, choice: tuple[str, str] | None) -> bool:
    return choice is not None and choice[0] in {fix.fix_id for fix in spot.fixes}


def _apply_default_fixes(proposal: Proposal, spots: list[Spot]) -> tuple[Script, EditPlan]:
    blocks = {block.block_id: block for block in proposal.script.blocks}
    entries = {entry.seg_id: entry for entry in proposal.edit_plan.entries}
    for spot in spots:
        if not spot.fixes:
            raise ValueError(f"spot {spot.spot_id} has no default fix")
        patch = spot.fixes[0].patch
        if patch.block is not None:
            block = blocks.get(patch.block.block_id)
            if block is None:
                raise ValueError(f"default fix refers to unknown block {patch.block.block_id}")
            blocks[block.block_id] = block.model_copy(update={"text": patch.block.text})
        elif patch.entry is not None:
            entry = entries.get(patch.entry.seg_id)
            if entry is None:
                raise ValueError(f"default fix refers to unknown segment {patch.entry.seg_id}")
            entries[entry.seg_id] = entry.model_copy(
                update={
                    "action": patch.entry.action,
                    "speed": patch.entry.speed,
                    "freeze_s": patch.entry.freeze_s,
                }
            )
    return (
        proposal.script.model_copy(update={"blocks": list(blocks.values())}),
        proposal.edit_plan.model_copy(update={"entries": list(entries.values())}),
    )
