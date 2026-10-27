"""Tests for the shared Pydantic package in app.contracts.

Literals are checked against the enum labels in every ordered schema migration, so the
Python names cannot drift from the database.
"""

import ast
import re
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import ValidationError

from app.auth.schemas import SignUp
from app.contracts import enums
from app.contracts.pipeline import AgentState, Proposal, SegContext, merge_by
from app.glossary.schemas import GlossaryTerm
from app.runs.schemas import RunCreate
from app.shares.schemas import ShareCreate
from app.videos.schemas import Page, Video

REPO = Path(__file__).resolve().parents[3]
SQL_DIR = REPO / "docs" / "design" / "sql"
MODELS_DIR = Path(__file__).resolve().parents[2] / "app" / "contracts"
FIXTURE = Path(__file__).resolve().parents[2] / "app" / "pipeline" / "fixtures" / "proposal.json"

# SQL enum name -> the Python Literal alias that must carry the same labels in the same order.
PAIRS: dict[str, Any] = {
    "member_role": enums.MemberRole,
    "video_status": enums.VideoStatus,
    "run_mode": enums.RunMode,
    "voice_mode": enums.VoiceMode,
    "run_status": enums.RunStatus,
    "proposal_src": enums.ProposalSource,
    "share_vis": enums.ShareVisibility,
    "edit_kind": enums.EditKind,
}

_ENUM_RE = re.compile(r"create\s+type\s+(\w+)\s+as\s+enum\s*\((.*?)\)\s*;", re.IGNORECASE | re.DOTALL)
_ADD_ENUM_VALUE_RE = re.compile(r"alter\s+type\s+(\w+)\s+add\s+value\s+'([^']+)'", re.IGNORECASE)


def parse_sql_enums(text: str) -> dict[str, tuple[str, ...]]:
    """Parse enum declarations and later labels in SQL statement order."""
    statements = [(m.start(), "create", m) for m in _ENUM_RE.finditer(text)] + [
        (m.start(), "add", m) for m in _ADD_ENUM_VALUE_RE.finditer(text)
    ]
    enums: dict[str, list[str]] = {}
    for _, kind, match in sorted(statements, key=lambda item: item[0]):
        if kind == "create":
            enums[match.group(1)] = re.findall(r"'([^']+)'", match.group(2))
        elif match.group(1) in enums:
            enums[match.group(1)].append(match.group(2))
    return {name: tuple(labels) for name, labels in enums.items()}


def sql_enums() -> dict[str, tuple[str, ...]]:
    files = sorted(path for path in SQL_DIR.glob("[0-9][0-9]_*.sql") if not path.name.endswith("_tests.sql"))
    return parse_sql_enums("\n".join(path.read_text() for path in files))


def seg(seg_id: str, label: str) -> SegContext:
    return SegContext(
        seg_id=seg_id,
        label=label,
        reasoning="",
        cuttable=True,
        min_dur=0.3,
        max_dur=3.0,
        max_speed=2.0,
        by="code",
    )


def test_fixture_validates_and_round_trips() -> None:
    proposal = Proposal.model_validate_json(FIXTURE.read_text())
    again = Proposal.model_validate_json(proposal.model_dump_json())
    assert again == proposal
    assert proposal.version == 1
    assert proposal.source == "agent"


def test_fixture_is_internally_consistent() -> None:
    proposal = Proposal.model_validate_json(FIXTURE.read_text())
    seg_ids = {c.seg_id for c in proposal.seg_contexts}
    block_ids = {b.block_id for b in proposal.script.blocks}
    for entry in proposal.edit_plan.entries:
        assert entry.seg_id in seg_ids
        assert entry.block_id is None or entry.block_id in block_ids
        assert 0.0 <= entry.src[0] < entry.src[1] <= 60.0
    for block in proposal.script.blocks:
        assert set(block.seg_ids) <= seg_ids
        assert block.target_min <= block.target_max
    assert {c.name for c in proposal.checks if not c.passed} == {"block_est_within_target"}


def test_merge_by_replaces_by_id_and_keeps_order() -> None:
    merge = merge_by("seg_id")
    left = [seg("s1", "old one"), seg("s2", "two")]
    right = [seg("s1", "new one"), seg("s3", "three")]
    merged = merge(left, right)
    assert [c.seg_id for c in merged] == ["s1", "s2", "s3"]
    assert merged[0].label == "new one"
    assert merged[1].label == "two"


def test_agent_state_uses_merge_by_for_seg_contexts() -> None:
    # The reducer is attached through Annotated metadata; pydantic keeps it on the field.
    metadata = AgentState.model_fields["seg_contexts"].metadata
    assert len(metadata) == 1 and callable(metadata[0])


@pytest.mark.parametrize("sql_name", sorted(PAIRS))
def test_literal_matches_sql_enum(sql_name: str) -> None:
    assert get_args(PAIRS[sql_name]) == sql_enums()[sql_name]


def test_every_sql_enum_is_covered() -> None:
    assert set(PAIRS) == set(sql_enums())


def test_sql_enum_parser_adds_values_and_ignores_owner_changes() -> None:
    sql = """
    create type share_kind as enum ('cleaned');
    alter type share_kind add value 'raw';
    alter type share_kind owner to app_api;
    """

    assert parse_sql_enums(sql) == {"share_kind": ("cleaned", "raw")}


def test_run_create_requires_voice_id_iff_ai() -> None:
    assert RunCreate(mode="review", voice="original").voice_id is None
    assert RunCreate(mode="auto", voice="ai", voice_id="voice-123").voice_id == "voice-123"
    with pytest.raises(ValidationError):
        RunCreate(mode="review", voice="ai")
    with pytest.raises(ValidationError):
        RunCreate(mode="review", voice="original", voice_id="voice-123")


def test_share_create_defaults_to_link() -> None:
    assert ShareCreate().visibility == "link"


def test_page_is_generic_over_items() -> None:
    page = Page[GlossaryTerm].model_validate({"items": [{"term": "PDF", "pronunciation": None}]})
    assert page.next_cursor is None
    assert page.items[0].term == "PDF"


def test_video_round_trip_with_run_summary() -> None:
    raw = {
        "id": "2b9d1f3e-7a10-4c55-8e21-9d0c4a6f7b11",
        "workspace_id": "5a0e2c1d-0f3b-4e8a-b7c6-1d2e3f4a5b6c",
        "title": "Quarterly export",
        "status": "awaiting_review",
        "duration_s": 60.0,
        "width": 1920,
        "height": 1080,
        "fps": 30.0,
        "created_at": "2026-10-18T09:00:00Z",
        "updated_at": "2026-10-18T09:05:00Z",
        "current_run": {"run_id": "7c1f0a52-3d4e-4b8a-9f61-2e5d8a6b1c20", "status": "awaiting_review"},
        "playback_url": "https://storage.example/raw.mp4?sig=abc",
    }
    video = Video.model_validate(raw)
    assert video.current_run is not None and video.current_run.stage is None
    assert Video.model_validate_json(video.model_dump_json()) == video


def test_sign_up_rejects_short_password_and_bad_email() -> None:
    SignUp(email="user@example.com", password="long-enough-pw")
    with pytest.raises(ValidationError):
        SignUp(email="user@example.com", password="short")
    with pytest.raises(ValidationError):
        SignUp(email="not-an-email", password="long-enough-pw")


def test_contracts_have_no_framework_or_app_imports() -> None:
    """Contracts cross every boundary, so they import no framework, driver or other app package."""
    banned = ("fastapi", "starlette", "psycopg", "redis")
    for path in MODELS_DIR.glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                assert not name.startswith(banned), f"{path.name} imports {name}"
                assert not name.startswith("app.") or name.startswith("app.contracts"), (
                    f"{path.name} imports {name}"
                )
