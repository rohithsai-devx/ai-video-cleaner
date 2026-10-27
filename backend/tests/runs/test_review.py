"""Review at its interface: versions, the trust rule (one case per rejected field kind), approval.

Runs against the compose Postgres. The trust rule runs through save_edit with the run locked.
"""
# ruff: noqa: F401, F811  (fixtures come from test_api)

import copy
import re
from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx
import pytest
from psycopg.types.json import Jsonb

from app.auth.security import decode_token
from app.contracts.events import RunStatusEvent
from app.contracts.pipeline import Proposal
from app.runs import lifecycle, review
from app.runs.schemas import ProposalUpdate
from app.shared.db import tenant_tx
from tests.factories import (
    FIXTURE,
    FakeStorage,
    _run_awaiting_review,
    _transcript,
    _uploaded_video,
    _user,
    api,
    published,
    storage,
    worker_tx,
)


def _uid(h: dict[str, str]) -> UUID:
    return decode_token(h["Authorization"].removeprefix("Bearer "))


def _body() -> dict[str, Any]:
    """A PUT body equal to the stored version 1."""
    body = copy.deepcopy({k: FIXTURE[k] for k in ("script", "edit_plan", "seg_contexts")})
    return {**body, "base_version": 1}


async def _review_run(
    api: httpx.AsyncClient, storage: FakeStorage, *, fix_options: dict[str, bool] | None = None
) -> tuple[dict[str, str], UUID, UUID]:
    h = await _user(api)
    video, run_id = await _run_awaiting_review(api, h, storage, fix_options=fix_options)
    return h, _uid(h), UUID(run_id)


async def _save(uid: UUID, run_id: UUID, body: dict[str, Any]) -> Proposal:
    async with tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        return await review.save_edit(conn, run, ProposalUpdate.model_validate(body))


async def _review_run_with_spot(
    api: httpx.AsyncClient, storage: FakeStorage, *, with_peaks: bool = False
) -> tuple[dict[str, str], UUID, UUID]:
    h = await _user(api)
    uid = _uid(h)
    video = await _uploaded_video(api, h, storage)
    async with tenant_tx(uid) as conn:
        run, _ = await lifecycle.start(
            conn, video_id=UUID(video["id"]), mode="review", voice="original", voice_id=None
        )
    pre = {
        "duration": 62.0,
        "keyframes": [],
        "words": _transcript(FIXTURE["script"]),
        "segments": [],
    }
    if with_peaks:
        peaks_uri = f"gs://test-bucket/runs/{run.id}/pre/audio-peaks.json"
        pre["peaks_uri"] = peaks_uri
        storage.objects.add(peaks_uri)
    block_id = FIXTURE["script"]["blocks"][0]["block_id"]
    spot = {
        "spot_id": "spot_01",
        "span": [0.0, 2.0],
        "question": "Should this line stay in the video?",
        "fixes": [
            {
                "fix_id": "fix_01",
                "label": "Use a shorter line",
                "patch": {
                    "block": {
                        "block_id": block_id,
                        "text": "Today I'll show how to export the quarterly report.",
                    }
                },
            }
        ],
        "chosen_fix_id": None,
        "chosen_by": None,
    }
    async with worker_tx(video["workspace_id"]) as conn:
        current = await lifecycle.load(conn, run.id)
        assert current is not None
        await lifecycle.advance(conn, current, "preprocessing", stage="preprocess")
        current = await lifecycle.load(conn, run.id)
        assert current is not None
        await lifecycle.advance(conn, current, "agent_running", stage="agent")
        await conn.execute("update runs set pre = %s where id = %s", (Jsonb(pre), run.id))
        await conn.execute(
            "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
            " seg_contexts, transcript_ctx, checks, spots)"
            " values (%s, %s, 1, 'agent', %s, %s, %s, %s, %s, %s)",
            (
                video["workspace_id"],
                run.id,
                Jsonb(FIXTURE["script"]),
                Jsonb(FIXTURE["edit_plan"]),
                Jsonb(FIXTURE["seg_contexts"]),
                Jsonb(FIXTURE["transcript_ctx"]),
                Jsonb(FIXTURE["checks"]),
                Jsonb([spot]),
            ),
        )
        current = await lifecycle.load(conn, run.id)
        assert current is not None
        await lifecycle.advance(conn, current, "awaiting_review", stage="review")
    return h, uid, run.id


def _block(b: dict[str, Any]) -> None:
    b["script"]["blocks"].pop(0)


def _block_timing(b: dict[str, Any]) -> None:
    b["script"]["blocks"][0]["target_max"] += 1


def _entry_removed(b: dict[str, Any]) -> None:
    b["edit_plan"]["entries"].pop(0)


def _entry_src(b: dict[str, Any]) -> None:
    src = b["edit_plan"]["entries"][0]["src"]
    b["edit_plan"]["entries"][0]["src"] = [src[0], src[1] + 0.5]


def _entry_block_id(b: dict[str, Any]) -> None:
    b["edit_plan"]["entries"][0]["block_id"] = "b-hijacked"


def _context_label(b: dict[str, Any]) -> None:
    b["seg_contexts"][0]["label"] += " (edited)"


def _context_removed(b: dict[str, Any]) -> None:
    b["seg_contexts"].pop(0)


# one case per rejected field kind: (id, mutation, the field path the error must name)
REJECTED: list[tuple[str, Callable[[dict[str, Any]], None], str]] = [
    ("script-block-removed", _block, "script.blocks ids"),
    ("script-block-timing", _block_timing, "target_max"),
    ("edit-entry-removed", _entry_removed, "edit_plan.entries ids"),
    ("edit-entry-src", _entry_src, ".src"),
    ("edit-entry-block-id", _entry_block_id, ".block_id"),
    ("seg-context-label", _context_label, ".label"),
    ("seg-context-removed", _context_removed, "seg_contexts ids"),
]


@pytest.mark.parametrize(
    ("mutate", "field"), [(m, f) for _, m, f in REJECTED], ids=[i for i, _, _ in REJECTED]
)
async def test_trust_rule_refuses_a_non_editable_field(
    api: httpx.AsyncClient, storage: FakeStorage, mutate: Callable[[dict[str, Any]], None], field: str
) -> None:
    h, uid, run_id = await _review_run(api, storage)
    body = _body()
    mutate(body)
    with pytest.raises(review.EditNotAllowed, match=re.escape(field)):
        await _save(uid, run_id, body)
    assert (await api.get(f"/runs/{run_id}/proposal", headers=h)).json()["proposal"]["version"] == 1


async def test_editable_fields_save_as_version_two(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h, uid, run_id = await _review_run(api, storage)
    body = _body()
    body["script"]["blocks"][0]["text"] = "Edited opening line."
    body["edit_plan"]["entries"][0].update(action="speed", speed=1.5, freeze_s=0.5)
    body["seg_contexts"][0]["must_keep"] = [[0.0, 1.0]]

    saved = await _save(uid, run_id, body)
    assert saved.version == 2 and saved.source == "user"
    proposal_view = (await api.get(f"/runs/{run_id}/proposal", headers=h)).json()
    assert proposal_view["script_lines"] == []
    assert proposal_view["waveform_url"] is None
    view = proposal_view["proposal"]
    assert view["version"] == 2 and view["script"]["blocks"][0]["text"] == "Edited opening line."


async def test_user_edit_can_override_a_disabled_fix_option(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run(
        api,
        storage,
        fix_options={"pauses": True, "filler": True, "retakes": True, "slow_parts": False},
    )
    body = _body()
    body["edit_plan"]["entries"][0].update(action="speed", speed=1.5)

    saved = await _save(uid, run_id, body)
    result = next(check for check in saved.checks if check.name == "fix_options_respected")
    assert saved.source == "user" and result.passed is True


async def test_queued_run_is_not_reviewable(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    async with tenant_tx(_uid(h)) as conn:
        ref, _ = await lifecycle.start(
            conn, video_id=UUID(video["id"]), mode="review", voice="original", voice_id=None
        )
    with pytest.raises(review.NotReviewable):
        await _save(_uid(h), ref.id, _body())
    async with tenant_tx(_uid(h)) as conn:
        run = await lifecycle.load(conn, ref.id)
        assert run is not None
        with pytest.raises(review.NotReviewable):
            await review.approve(conn, run)


async def test_awaiting_review_without_a_proposal_has_no_proposal(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h = await _user(api)
    video = await _uploaded_video(api, h, storage)
    async with tenant_tx(_uid(h)) as conn:
        ref, _ = await lifecycle.start(
            conn, video_id=UUID(video["id"]), mode="review", voice="original", voice_id=None
        )
    async with worker_tx(video["workspace_id"]) as w:
        for to in ("preprocessing", "agent_running", "awaiting_review"):
            run = await lifecycle.load(w, ref.id)
            assert run is not None
            await lifecycle.advance(w, run, to)  # type: ignore[arg-type]
    with pytest.raises(review.NoProposal):
        await _save(_uid(h), ref.id, _body())


async def test_approve_refuses_an_edl_that_breaks_the_render(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run(api, storage)
    body = _body()
    body["edit_plan"]["entries"][0].update(action="speed", speed=5.0)
    await _save(uid, run_id, body)  # saved, with a failed check

    async with tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        with pytest.raises(review.InvalidEdl) as e:
            await review.approve(conn, run)
    assert e.value.check.name == "edl_valid" and not e.value.check.passed
    assert (await api.get(f"/runs/{run_id}", headers=h)).json()["status"] == "awaiting_review"


async def test_approve_marks_video_rendering_and_emits_status(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run(api, storage)
    video_id = (await api.get(f"/runs/{run_id}", headers=h)).json()["video_id"]
    async with tenant_tx(uid) as conn:
        run = await lifecycle.load(conn, run_id)
        assert run is not None
        events = await review.approve(conn, run)
    assert events == [("run.status", RunStatusEvent(status="approved", stage="approved"))]
    assert (await api.get(f"/videos/{video_id}", headers=h)).json()["status"] == "rendering"
    body = (await api.get(f"/runs/{run_id}", headers=h)).json()
    assert body["status"] == "approved" and body["stage"] == "approved"


async def test_chosen_fix_is_saved_and_returned_in_proposal_view(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run_with_spot(api, storage)
    body = _body()
    body["chosen_fixes"] = {"spot_01": "fix_01"}
    run = (await api.get(f"/runs/{run_id}", headers=h)).json()
    items = (await api.get(f"/videos/{run['video_id']}/runs", headers=h)).json()
    assert items[0]["needs_you"] == 1

    response = await api.put(f"/runs/{run_id}/proposal", json=body, headers=h)

    assert response.status_code == 200, response.text
    spot = response.json()["spots"][0]
    assert spot["chosen_fix_id"] == "fix_01" and spot["chosen_by"] == "user"
    run = (await api.get(f"/runs/{run_id}", headers=h)).json()
    items = (await api.get(f"/videos/{run['video_id']}/runs", headers=h)).json()
    assert items[0]["needs_you"] == 0
    async with tenant_tx(uid) as conn:
        cur = await conn.execute(
            "select e.kind, e.target_id, e.user_value from review_edits e"
            " join proposals p on p.id = e.proposal_id where p.run_id = %s and e.kind = 'fix_chosen'",
            (run_id,),
        )
        saved_choice = await cur.fetchone()
    assert saved_choice is not None
    assert saved_choice["target_id"] == "spot_01"
    assert saved_choice["user_value"] == {"fix_id": "fix_01", "by": "user"}


async def test_approve_applies_the_default_fix_to_a_new_version(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, _, run_id = await _review_run_with_spot(api, storage)

    response = await api.post(f"/runs/{run_id}/approve", json={"base_version": 1}, headers=h)

    assert response.status_code == 202, response.text
    view = (await api.get(f"/runs/{run_id}/proposal", headers=h)).json()
    assert view["proposal"]["version"] == 2
    assert view["proposal"]["source"] == "user"
    assert (
        view["proposal"]["script"]["blocks"][0]["text"]
        == "Today I'll show how to export the quarterly report."
    )
    assert view["spots"][0]["chosen_fix_id"] == "fix_01"
    assert view["spots"][0]["chosen_by"] == "default"


async def test_proposal_view_signs_preprocess_waveform_peaks(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, _, run_id = await _review_run_with_spot(api, storage, with_peaks=True)

    response = await api.get(f"/runs/{run_id}/proposal", headers=h)

    assert response.status_code == 200, response.text
    assert response.json()["waveform_url"] == (f"http://fake-play/runs/{run_id}/pre/audio-peaks.json")


async def test_save_on_a_stale_base_version_is_a_version_conflict(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run(api, storage)
    await _save(uid, run_id, _body())  # someone else saved version 2
    body = _body()
    body["script"]["blocks"][0]["text"] = "My edit on version 1."
    with pytest.raises(review.VersionConflict):
        await _save(uid, run_id, body)

    r = await api.put(f"/runs/{run_id}/proposal", json=body, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "version_conflict", r.text
    assert (await api.get(f"/runs/{run_id}/proposal", headers=h)).json()["proposal"]["version"] == 2

    r = await api.put(f"/runs/{run_id}/proposal", json={**body, "base_version": 2}, headers=h)
    assert r.status_code == 200 and r.json()["proposal"]["version"] == 3, r.text


async def test_put_requires_base_version(api: httpx.AsyncClient, storage: FakeStorage) -> None:
    h, _, run_id = await _review_run(api, storage)
    body = _body()
    del body["base_version"]
    assert (await api.put(f"/runs/{run_id}/proposal", json=body, headers=h)).status_code == 422


async def test_approve_on_a_stale_base_version_is_a_version_conflict(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, uid, run_id = await _review_run(api, storage)
    await _save(uid, run_id, _body())  # version 2
    r = await api.post(f"/runs/{run_id}/approve", json={"base_version": 1}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "version_conflict", r.text
    assert (await api.get(f"/runs/{run_id}", headers=h)).json()["status"] == "awaiting_review"

    r = await api.post(f"/runs/{run_id}/approve", json={"base_version": 2}, headers=h)
    assert r.status_code == 202, r.text


async def test_approve_without_a_body_approves_the_latest(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, _, run_id = await _review_run(api, storage)
    r = await api.post(f"/runs/{run_id}/approve", headers=h)
    assert r.status_code == 202, r.text


async def test_review_on_a_run_not_awaiting_review_is_not_awaiting_review(
    api: httpx.AsyncClient, storage: FakeStorage
) -> None:
    h, _, run_id = await _review_run(api, storage)
    r = await api.post(f"/runs/{run_id}/approve", json={"base_version": 1}, headers=h)
    assert r.status_code == 202, r.text
    r = await api.put(f"/runs/{run_id}/proposal", json=_body(), headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_awaiting_review", r.text
    r = await api.post(f"/runs/{run_id}/approve", json={"base_version": 1}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_awaiting_review", r.text
