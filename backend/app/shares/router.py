"""Share links: create one for a video, and the public share page data."""

import secrets
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from app.auth import CurrentUser
from app.shared.config import get_settings
from app.shared.db import anon_tx, tenant_tx
from app.shared.errors import not_found
from app.shared.storage import StorageDep
from app.shares.schemas import ShareCreate, ShareCreated, SharePublic

router = APIRouter(tags=["shares"])


@router.post("/videos/{video_id}/shares", status_code=status.HTTP_201_CREATED)
async def create_share(video_id: UUID, body: ShareCreate, user_id: CurrentUser) -> ShareCreated:
    slug = secrets.token_urlsafe(16)  # 22 chars of [A-Za-z0-9_-]
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute("select workspace_id from videos where id = %s", (video_id,))
        video = await cur.fetchone()
        if video is None:
            raise not_found()
        await conn.execute(
            "insert into shares (workspace_id, video_id, slug, visibility, expires_at, created_by)"
            " values (%s, %s, %s, %s, %s, app.uid())",
            (video["workspace_id"], video_id, slug, body.visibility, body.expires_at),
        )
    return ShareCreated(slug=slug, url=f"{get_settings().frontend_base_url.rstrip('/')}/s/{slug}")


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
