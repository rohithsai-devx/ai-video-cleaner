"""Share links: create one for a video, and the public share page data."""

import secrets
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status

from app.auth import CurrentUser
from app.shared.config import get_settings
from app.shared.db import anon_tx, tenant_tx
from app.shared.errors import not_found
from app.shared.storage import StorageDep
from app.shares.schemas import ShareCreate, ShareCreated, ShareLink, SharePublic

router = APIRouter(tags=["shares"])


@router.post(
    "/videos/{video_id}/shares",
    status_code=status.HTTP_201_CREATED,
    responses={status.HTTP_200_OK: {"model": ShareCreated}},
)
async def create_share(
    video_id: UUID, body: ShareCreate, user_id: CurrentUser, response: Response
) -> ShareCreated:
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select workspace_id from videos where id = %s for update", (video_id,))
        video = await cur.fetchone()
        if video is None:
            raise not_found()
        if body.visibility == "link":
            cur = await conn.execute(
                "select slug from shares where video_id = %s and visibility = 'link'"
                " and (expires_at is null or expires_at > now()) order by created_at desc limit 1",
                (video_id,),
            )
            existing = await cur.fetchone()
            if existing is not None:
                response.status_code = status.HTTP_200_OK
                return _created(existing["slug"], kind="cleaned")

        slug = secrets.token_urlsafe(16)  # 22 chars of [A-Za-z0-9_-]
        await conn.execute(
            "insert into shares (workspace_id, video_id, slug, visibility, expires_at, created_by)"
            " values (%s, %s, %s, %s, %s, app.uid())",
            (video["workspace_id"], video_id, slug, body.visibility, body.expires_at),
        )
    return _created(slug, kind="cleaned")


def _created(slug: str, *, kind: Literal["cleaned"]) -> ShareCreated:
    return ShareCreated(slug=slug, url=f"{get_settings().frontend_base_url.rstrip('/')}/s/{slug}", kind=kind)


@router.get("/videos/{video_id}/shares")
async def list_shares(video_id: UUID, user_id: CurrentUser) -> list[ShareLink]:
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select id from videos where id = %s", (video_id,))
        if await cur.fetchone() is None:
            raise not_found()
        cur = await conn.execute(
            "select slug, created_at from shares where video_id = %s and visibility = 'link'"
            " order by created_at desc",
            (video_id,),
        )
        rows = await cur.fetchall()
    base_url = get_settings().frontend_base_url.rstrip("/")
    return [
        ShareLink(
            slug=row["slug"],
            url=f"{base_url}/s/{row['slug']}",
            kind="cleaned",
            created_at=row["created_at"],
        )
        for row in rows
    ]


@router.get("/s/{slug}")
async def public_share(slug: str, storage: StorageDep) -> SharePublic:
    # anonymous viewer: no tenant identity; app.resolve_share (SECURITY DEFINER) returns only playback fields
    async with anon_tx() as conn:
        cur = await conn.execute("select * from app.resolve_share(%s)", (slug,))
        row = await cur.fetchone()
    if row is None:
        raise not_found("share")
    playback, poster = await storage.sign(row["output_uri"], row["poster_uri"])
    if playback is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share not found")
    return SharePublic(title=row["title"], playback_url=playback, poster_url=poster)
