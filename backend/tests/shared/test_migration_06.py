"""Migration 06 keeps stored proposals readable after the transcript field rename."""

import os
import shutil
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from scripts.migrate import apply_migrations, drop_database, load_dotenv, recreate_database, with_dbname

REPO = Path(__file__).resolve().parents[3]
SQL_DIR = REPO / "docs" / "design" / "sql"


def _copy_migrations(destination: Path, through: int) -> Path:
    destination.mkdir()
    for path in sorted(SQL_DIR.glob("[0-9][0-9]_*.sql")):
        number = int(path.name[:2])
        if number <= through and not path.name.endswith("_tests.sql"):
            shutil.copyfile(path, destination / path.name)
    return destination


def test_migration_06_renames_stored_proposal_fields(tmp_path: Path) -> None:
    load_dotenv()
    admin = os.environ.get("DATABASE_URL_ADMIN")
    if not admin:
        pytest.skip("DATABASE_URL_ADMIN is not configured")
    url = with_dbname(admin, f"avc_migration_06_{uuid4().hex[:8]}")
    recreate_database(url)
    try:
        before = _copy_migrations(tmp_path / "before", 5)
        after = _copy_migrations(tmp_path / "after", 6)
        apply_migrations(url, sql_dir=before, log=lambda _message: None)
        with psycopg.connect(url, autocommit=True) as conn:
            for _ in range(2):
                user_id, workspace_id, video_id, run_id = (uuid4() for _ in range(4))
                conn.execute(
                    "insert into users (id, email) values (%s, %s)", (user_id, f"{user_id}@example.com")
                )
                conn.execute(
                    "insert into workspaces (id, name) values (%s, 'migration test')", (workspace_id,)
                )
                conn.execute(
                    "insert into videos (id, workspace_id, owner_id) values (%s, %s, %s)",
                    (video_id, workspace_id, user_id),
                )
                conn.execute(
                    "insert into runs (id, workspace_id, video_id, created_by, mode, voice)"
                    " values (%s, %s, %s, %s, 'review', 'original')",
                    (run_id, workspace_id, video_id, user_id),
                )
                conn.execute(
                    "insert into proposals (workspace_id, run_id, version, source, script, edit_plan,"
                    " seg_contexts, transcript_ctx, checks) values (%s, %s, 1, 'agent', %s, %s, %s, %s, %s)",
                    (
                        workspace_id,
                        run_id,
                        Jsonb({}),
                        Jsonb({}),
                        Jsonb([]),
                        Jsonb({"steps": [], "glossary": ["PDF"], "drops": []}),
                        Jsonb([{"name": "glossary_kept", "passed": True, "target": "script_writer"}]),
                    ),
                )

        apply_migrations(url, sql_dir=after, log=lambda _message: None)
        with psycopg.connect(url) as conn:
            rows = conn.execute("select transcript_ctx, checks from proposals order by id").fetchall()
        assert len(rows) == 2
        for transcript_ctx, checks in rows:
            assert transcript_ctx["key_terms"] == ["PDF"]
            assert "glossary" not in transcript_ctx
            assert any(check["name"] == "key_terms_kept" for check in checks)
            assert all(check["name"] != "glossary_kept" for check in checks)
    finally:
        drop_database(url)
