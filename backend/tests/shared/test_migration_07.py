"""Migration 07 drops the unused workspace terms table."""

import os
import re
import shutil
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from scripts.migrate import apply_migrations, drop_database, load_dotenv, recreate_database, with_dbname

REPO = Path(__file__).resolve().parents[3]
SQL_DIR = REPO / "docs" / "design" / "sql"


def _copy_migrations(destination: Path, through: int) -> Path:
    destination.mkdir()
    for path in sorted(SQL_DIR.glob("[0-9][0-9]_*.sql")):
        if int(path.name[:2]) <= through and not path.name.endswith("_tests.sql"):
            shutil.copyfile(path, destination / path.name)
    return destination


def test_migration_07_drops_workspace_terms(tmp_path: Path) -> None:
    load_dotenv()
    admin = os.environ.get("DATABASE_URL_ADMIN")
    if not admin:
        pytest.skip("DATABASE_URL_ADMIN is not configured")
    url = with_dbname(admin, f"avc_migration_07_{uuid4().hex[:8]}")
    recreate_database(url)
    try:
        before = _copy_migrations(tmp_path / "before", 6)
        after = _copy_migrations(tmp_path / "after", 7)
        migration_path = next(path for path in after.iterdir() if path.name.startswith("07_"))
        sql = migration_path.read_text()
        match = re.search(r"drop table ([a-z_]+);", sql)
        assert match is not None
        table_name = match.group(1)
        apply_migrations(url, sql_dir=before, log=lambda _message: None)
        with psycopg.connect(url) as conn:
            row = conn.execute("select to_regclass(%s)", (f"public.{table_name}",)).fetchone()
            assert row is not None
            existing = row[0]
            assert existing == table_name

        apply_migrations(url, sql_dir=after, log=lambda _message: None)
        with psycopg.connect(url) as conn:
            row = conn.execute("select to_regclass(%s)", (f"public.{table_name}",)).fetchone()
            assert row is not None
            assert row[0] is None
    finally:
        drop_database(url)
