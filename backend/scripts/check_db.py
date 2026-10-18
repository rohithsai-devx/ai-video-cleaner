"""Fresh-migrate a throwaway database, run 03_rls_tests.sql, exit nonzero on any FAIL or ERROR.

The test file is psql-flavoured; it is run statement by statement (like psql with ON_ERROR_STOP off),
so no psql binary is needed. Seeding runs as the admin role, which is test-only.
"""

from __future__ import annotations

import os
import sys
import uuid

import psycopg
from migrate import SQL_DIR, apply_migrations, drop_database, load_dotenv, recreate_database, with_dbname

TESTS = SQL_DIR / "03_rls_tests.sql"


def split_statements(text: str) -> list[str]:
    """Split SQL on top-level semicolons (quote-, dollar-quote- and comment-aware); drop psql meta lines."""
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("\\")]
    src = "\n".join(lines)
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "-" and src.startswith("--", i):
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "'":
            j = i + 1
            while j < n:
                if src[j] == "'" and src.startswith("''", j):
                    j += 2
                    continue
                if src[j] == "'":
                    break
                j += 1
            buf.append(src[i : j + 1])
            i = j + 1
            continue
        if c == "$":
            j = src.find("$", i + 1)
            tag = src[i : j + 1] if j != -1 else ""
            if tag and (tag == "$$" or tag[1:-1].replace("_", "a").isalnum()):
                end = src.find(tag, j + 1)
                end = n if end == -1 else end + len(tag)
                buf.append(src[i:end])
                i = end
                continue
        if c == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def run_tests(url: str) -> tuple[int, int, int]:
    passes = fails = errors = 0

    def note(diag: psycopg.errors.Diagnostic) -> None:
        nonlocal passes, fails
        msg = diag.message_primary or ""
        print(f"NOTICE: {msg}")
        passes += msg.startswith("PASS")
        fails += "FAIL" in msg

    with psycopg.connect(url, autocommit=True) as conn:
        conn.add_notice_handler(note)
        for stmt in split_statements(TESTS.read_text()):
            try:
                cur = conn.execute(stmt.encode())
                if cur.description is not None:
                    for row in cur.fetchall():
                        text = " ".join(str(v) for v in row)
                        if "PASS" in text or "FAIL" in text:
                            print(text)
                        passes += text.startswith("PASS")
                        fails += "FAIL" in text
            except psycopg.Error as e:
                errors += 1
                first = stmt.splitlines()[0][:100]
                print(f"ERROR: {str(e).strip().splitlines()[0]}  <- {first}")
    return passes, fails, errors


def main() -> int:
    load_dotenv()
    admin = os.environ.get("DATABASE_URL_ADMIN")
    if not admin:
        print("DATABASE_URL_ADMIN is not set", file=sys.stderr)
        return 2
    url = with_dbname(admin, f"avc_check_{uuid.uuid4().hex[:8]}")
    recreate_database(url)
    try:
        apply_migrations(url)
        passes, fails, errors = run_tests(url)
    finally:
        drop_database(url)
    print(f"\n{passes} passed, {fails} failed, {errors} errors")
    return 0 if passes and not fails and not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
