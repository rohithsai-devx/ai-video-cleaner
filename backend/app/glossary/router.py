"""Workspace glossary: product terms and their pronunciations."""

from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from psycopg import errors

from app.auth import CurrentUser
from app.glossary.schemas import GlossaryTerm
from app.shared.db import Conn, tenant_tx
from app.shared.errors import not_found

router = APIRouter(tags=["glossary"])


async def _require_workspace(conn: Conn, workspace_id: UUID) -> None:
    cur = await conn.execute("select 1 from workspaces where id = %s", (workspace_id,))
    if await cur.fetchone() is None:
        raise not_found("workspace")


async def _terms(conn: Conn, workspace_id: UUID) -> list[GlossaryTerm]:
    cur = await conn.execute(
        "select term, pronunciation from glossary_terms where workspace_id = %s order by term",
        (workspace_id,),
    )
    return [GlossaryTerm(term=r["term"], pronunciation=r["pronunciation"]) for r in await cur.fetchall()]


@router.get("/workspaces/{workspace_id}/glossary")
async def get_glossary(workspace_id: UUID, user_id: CurrentUser) -> list[GlossaryTerm]:
    async with tenant_tx(user_id) as conn:
        await _require_workspace(conn, workspace_id)
        return await _terms(conn, workspace_id)


@router.put("/workspaces/{workspace_id}/glossary")
async def put_glossary(
    workspace_id: UUID, body: list[GlossaryTerm], user_id: CurrentUser
) -> list[GlossaryTerm]:
    """Replace the whole glossary. Owners and admins only (enforced by RLS too)."""
    if len({t.term for t in body}) != len(body):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "duplicate terms")
    async with tenant_tx(user_id) as conn:
        await _require_workspace(conn, workspace_id)
        cur = await conn.execute("select app.has_role(%s, '{owner,admin}') as ok", (workspace_id,))
        if not (await cur.fetchone() or {}).get("ok"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "only owners and admins can edit the glossary")
        await conn.execute("delete from glossary_terms where workspace_id = %s", (workspace_id,))
        if body:
            try:
                async with conn.cursor() as c:
                    await c.executemany(
                        "insert into glossary_terms (workspace_id, term, pronunciation) values (%s, %s, %s)",
                        [(workspace_id, t.term, t.pronunciation) for t in body],
                    )
            except errors.CheckViolation:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid term") from None
        return await _terms(conn, workspace_id)
