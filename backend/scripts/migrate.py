"""Apply docs/design/sql/NN_*.sql (except *_tests.sql) in order, as the admin role.

Migrations only: DATABASE_URL_ADMIN is never used by the app. Applied files are recorded in
migrations.schema_migrations (outside `public`, so app roles have no access and the RLS guard is unaffected).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

BACKEND = Path(__file__).resolve().parent.parent
SQL_DIR = BACKEND.parent / "docs" / "design" / "sql"
MIGRATION_RE = re.compile(r"^\d{2}_.+\.sql$")
# Roles are cluster-wide, so a second database in the same cluster (a fresh dev db, check_db's throwaway db)
# finds them already there. Guard bare `create role` statements so they are skipped when the role exists.
CREATE_ROLE_RE = re.compile(r"^create role\s+(\w+)\b([^;]*);", re.IGNORECASE | re.MULTILINE)


def load_dotenv(path: Path = BACKEND / ".env") -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def migration_files(sql_dir: Path = SQL_DIR) -> list[Path]:
    return sorted(
        p for p in sql_dir.iterdir() if MIGRATION_RE.match(p.name) and not p.name.endswith("_tests.sql")
    )


def guard_create_role(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        name, opts = m.group(1), m.group(2)
        return (
            f"do $guard$ begin if not exists (select 1 from pg_roles where rolname = '{name}') then "
            f"create role {name}{opts}; end if; end $guard$;"
        )

    return CREATE_ROLE_RE.sub(repl, text)


def with_dbname(url: str, dbname: str) -> str:
    params = conninfo_to_dict(url)
    params["dbname"] = dbname
    return make_conninfo("", **{k: v for k, v in params.items() if v is not None})


def recreate_database(url: str) -> None:
    dbname = conninfo_to_dict(url).get("dbname")
    if not dbname:
        raise SystemExit("database url has no dbname")
    with psycopg.connect(with_dbname(url, "postgres"), autocommit=True) as conn:
        conn.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(str(dbname))))
        conn.execute(sql.SQL("create database {}").format(sql.Identifier(str(dbname))))


def drop_database(url: str) -> None:
    dbname = conninfo_to_dict(url)["dbname"]
    with psycopg.connect(with_dbname(url, "postgres"), autocommit=True) as conn:
        conn.execute(sql.SQL("drop database if exists {} with (force)").format(sql.Identifier(str(dbname))))


def apply_migrations(url: str, sql_dir: Path = SQL_DIR, log=print) -> list[str]:
    applied_now: list[str] = []
    with psycopg.connect(url, autocommit=True) as conn:
        # serialize concurrent migrators (e.g. two deploy jobs); released when the connection closes
        conn.execute("select pg_advisory_lock(hashtext('avc-migrate'))")
        conn.execute("create schema if not exists migrations")
        conn.execute("revoke all on schema migrations from public")
        conn.execute(
            "create table if not exists migrations.schema_migrations ("
            " filename text primary key, sha256 text not null,"
            " applied_at timestamptz not null default now())"
        )
        done = dict(conn.execute("select filename, sha256 from migrations.schema_migrations").fetchall())
        for path in migration_files(sql_dir):
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if path.name in done:
                if done[path.name] != digest:
                    raise SystemExit(f"{path.name} changed after it was applied (sha256 mismatch)")
                continue
            with conn.transaction():
                conn.execute(guard_create_role(raw.decode()).encode())
                conn.execute(
                    "insert into migrations.schema_migrations (filename, sha256) values (%s, %s)",
                    (path.name, digest),
                )
            applied_now.append(path.name)
            log(f"applied {path.name}")
    return applied_now


def set_dev_passwords(url: str) -> None:
    pairs = [
        ("app_api", os.environ.get("APP_API_PASSWORD")),
        ("app_worker", os.environ.get("APP_WORKER_PASSWORD")),
        ("app_relay", os.environ.get("APP_RELAY_PASSWORD")),
    ]
    with psycopg.connect(url, autocommit=True) as conn:
        for role, password in pairs:
            if password:
                conn.execute(
                    sql.SQL("alter role {} password {}").format(sql.Identifier(role), sql.Literal(password))
                )


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fresh", action="store_true", help="drop and recreate the target database first")
    parser.add_argument(
        "--dev-passwords",
        action="store_true",
        help="local dev only: set app_api/app_worker passwords from APP_*_PASSWORD",
    )
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL_ADMIN"))
    args = parser.parse_args(argv)
    if not args.database_url:
        print("DATABASE_URL_ADMIN is not set", file=sys.stderr)
        return 2
    if args.fresh:
        recreate_database(args.database_url)
    applied = apply_migrations(args.database_url)
    if not applied:
        print("up to date")
    if args.dev_passwords:
        set_dev_passwords(args.database_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
