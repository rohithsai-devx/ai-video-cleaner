"""Literal aliases for the Postgres enums in docs/design/sql/01_schema.sql.

Each alias lists exactly the enum labels, in the same order. tests/test_models.py parses the
SQL file and fails if they drift.
"""

from typing import Literal

MemberRole = Literal["owner", "admin", "member"]
VideoStatus = Literal[
    "uploading", "uploaded", "processing", "awaiting_review", "rendering", "ready", "failed"
]
RunMode = Literal["review", "auto"]
VoiceMode = Literal["original", "ai"]
RunStatus = Literal[
    "queued",
    "preprocessing",
    "agent_running",
    "awaiting_review",
    "approved",
    "postprocessing",
    "done",
    "failed",
    "cancelled",
]
ProposalSource = Literal["agent", "user"]
ShareVisibility = Literal["private", "workspace", "link"]
ShareKind = Literal["cleaned", "raw"]
EditKind = Literal["block_text", "cut_toggle", "speed", "must_keep"]

__all__ = [
    "EditKind",
    "MemberRole",
    "ProposalSource",
    "RunMode",
    "RunStatus",
    "ShareKind",
    "ShareVisibility",
    "VideoStatus",
    "VoiceMode",
]
