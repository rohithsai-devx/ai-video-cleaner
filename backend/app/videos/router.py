"""Videos: create + upload session, confirm upload, library list, detail, start a run."""

import base64
import binascii
import logging
import math
import re
from datetime import datetime
from pathlib import PurePosixPath
from statistics import median
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, HTTPException, Query, status
from psycopg import sql

from app.auth import CurrentUser
from app.runs.schemas import RunSummary
from app.shared.config import MAX_RECORDING_SECONDS
from app.shared.db import Conn, tenant_tx
from app.shared.errors import not_found
from app.shared.storage import GcsStorage, StorageDep
from app.videos.schemas import Page, Video, VideoCreate, VideoCreated, VideoUploaded

router = APIRouter(tags=["videos"])
log = logging.getLogger(__name__)

_VIDEO_SELECT = """
select v.*, r.status as run_status, r.stage as run_stage
  from videos v left join runs r on r.id = v.current_run_id
"""


async def fetch_video(conn: Conn, video_id: UUID) -> dict[str, Any] | None:
    cur = await conn.execute(_VIDEO_SELECT + " where v.id = %s", (video_id,))
    return await cur.fetchone()


def to_video(row: dict[str, Any], playback_url: str | None = None, poster_url: str | None = None) -> Video:
    run = (
        RunSummary(run_id=str(row["current_run_id"]), status=row["run_status"], stage=row["run_stage"])
        if row.get("current_run_id") and row.get("run_status")
        else None
    )
    return Video(
        id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        title=row["title"],
        status=row["status"],
        duration_s=float(row["duration_s"]) if row["duration_s"] is not None else None,
        estimated_run_seconds=row.get("estimated_run_seconds"),
        width=row["width"],
        height=row["height"],
        fps=float(row["fps"]) if row["fps"] is not None else None,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        current_run=run,
        playback_url=playback_url,
        poster_url=poster_url,
    )


_RAW_PLAYBACK = ("uploaded", "processing", "awaiting_review", "rendering")


async def video_with_playback(storage: GcsStorage, row: dict[str, Any]) -> Video:
    if row["status"] == "ready":
        media = row["output_uri"]
    elif row["status"] in _RAW_PLAYBACK:
        media = row.get("raw_uri")  # no output yet: play the recording
    else:
        media = None
    raw_uri = row.get("raw_uri")
    output_uri = row.get("output_uri") if row["status"] == "ready" else None
    slug = _filename_slug(row["title"])
    extension = PurePosixPath(raw_uri).suffix.lstrip(".") if raw_uri else ""
    original_download_name = f"{slug}-original.{extension}" if raw_uri and extension else None
    playback_url, poster_url, original_url, download_url, original_download_url = await storage.sign(
        media,
        row.get("poster_uri"),
        raw_uri,
        output_uri,
        raw_uri,
        download_names=[
            None,
            None,
            None,
            f"{slug}.mp4" if output_uri else None,
            original_download_name,
        ],
    )
    return to_video(row, playback_url, poster_url).model_copy(
        update={
            "original_url": original_url,
            "download_url": download_url,
            "original_download_url": original_download_url,
        }
    )


def _filename_slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "video"


@router.post("/videos", status_code=status.HTTP_201_CREATED)
async def create_video(body: VideoCreate, user_id: CurrentUser, storage: StorageDep) -> VideoCreated:
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute(
            "select w.id from workspaces w join workspace_members m on m.workspace_id = w.id"
            " where m.user_id = app.uid() order by w.created_at, w.id limit 1"
        )
        ws = await cur.fetchone()
        if ws is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "user has no workspace")
        cur = await conn.execute(
            "insert into videos (workspace_id, owner_id, title) values (%s, app.uid(), %s) returning id",
            (ws["id"], body.title),
        )
        row = await cur.fetchone()
        assert row is not None
    video_id: UUID = row["id"]
    # after commit: the session URL is only useful once the row exists
    url = await storage.upload_session(storage.raw_uri(video_id), "video/webm")
    try:
        poster_url: str | None = await storage.upload_session(storage.poster_uri(video_id), "image/jpeg")
    except Exception:  # the poster is optional: never fail the recording over it
        log.warning("poster upload session failed for video %s", video_id, exc_info=True)
        poster_url = None
    return VideoCreated(video_id=str(video_id), upload_url=url, poster_upload_url=poster_url)


@router.post("/videos/{video_id}/uploaded")
async def confirm_upload(
    video_id: UUID,
    user_id: CurrentUser,
    storage: StorageDep,
    body: Annotated[VideoUploaded | None, Body()] = None,
) -> Video:
    meta = body or VideoUploaded()
    if meta.duration_s is not None and meta.duration_s > MAX_RECORDING_SECONDS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"recording is longer than {MAX_RECORDING_SECONDS} seconds",
        )
    uri = storage.raw_uri(video_id)
    present = await storage.exists(uri)  # before the transaction
    poster = storage.poster_uri(video_id)
    try:
        has_poster = await storage.exists(poster)
    except Exception:  # optional, like at create
        log.warning("poster lookup failed for video %s", video_id, exc_info=True)
        has_poster = False
    async with tenant_tx(user_id) as conn:
        if present:
            cur = await conn.execute(
                "update videos set status = 'uploaded', raw_uri = %s,"
                " duration_s = coalesce(%s, duration_s), width = coalesce(%s, width),"
                " height = coalesce(%s, height), fps = coalesce(%s, fps),"
                " poster_uri = coalesce(%s, poster_uri)"
                " where id = %s and status = 'uploading'",
                (
                    uri,
                    meta.duration_s,
                    meta.width,
                    meta.height,
                    meta.fps,
                    poster if has_poster else None,
                    video_id,
                ),
            )
            updated = cur.rowcount
        else:
            updated = 0
        row = await fetch_video(conn, video_id)
    if row is None:
        raise not_found()
    if not present:
        raise HTTPException(status.HTTP_409_CONFLICT, "upload not found in storage")
    if not updated and row["status"] != "uploaded":
        raise HTTPException(status.HTTP_409_CONFLICT, f"video is {row['status']}, not uploading")
    return await video_with_playback(storage, row)


def _encode_cursor(created_at: datetime, video_id: UUID) -> str:
    return base64.urlsafe_b64encode(f"{created_at.isoformat()}|{video_id}".encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        ts, _, vid = base64.urlsafe_b64decode(cursor.encode()).decode().partition("|")
        return datetime.fromisoformat(ts), UUID(vid)
    except (ValueError, binascii.Error, UnicodeDecodeError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid cursor") from None


@router.get("/videos")
async def list_videos(
    user_id: CurrentUser,
    storage: StorageDep,
    workspace_id: UUID | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Page[Video]:
    after = _decode_cursor(cursor) if cursor else None
    where: list[sql.Composable] = [sql.SQL("true")]
    params: list[Any] = []
    if workspace_id is not None:
        where.append(sql.SQL("v.workspace_id = %s"))
        params.append(workspace_id)
    if after is not None:
        where.append(sql.SQL("(v.created_at, v.id) < (%s, %s)"))
        params.extend(after)
    query = sql.SQL("{} where {} order by v.created_at desc, v.id desc limit %s").format(
        sql.SQL(_VIDEO_SELECT), sql.SQL(" and ").join(where)
    )
    async with tenant_tx(user_id) as conn:
        cur = await conn.execute(query, (*params, limit + 1))
        rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    items = [await video_with_playback(storage, r) for r in rows]
    nxt = _encode_cursor(rows[-1]["created_at"], rows[-1]["id"]) if more else None
    return Page[Video](items=items, next_cursor=nxt)


@router.get("/videos/{video_id}")
async def get_video(video_id: UUID, user_id: CurrentUser, storage: StorageDep) -> Video:
    async with tenant_tx(user_id) as conn:
        row = await fetch_video(conn, video_id)
        if row is not None:
            row["estimated_run_seconds"] = await _estimate_run_seconds(
                conn, row["workspace_id"], row["duration_s"]
            )
    if row is None:
        raise not_found()
    return await video_with_playback(storage, row)


async def _estimate_run_seconds(conn: Conn, workspace_id: UUID, duration_s: float | None) -> int | None:
    if duration_s is None:
        return None

    cur = await conn.execute(
        "with recent as ("
        " select r.started_at, r.finished_at, source.duration_s"
        " from runs r join videos source on source.id = r.video_id and source.workspace_id = r.workspace_id"
        " where r.workspace_id = %s and r.status = 'done'"
        " order by r.finished_at desc limit 20"
        ") select started_at, finished_at, duration_s from recent",
        (workspace_id,),
    )
    rows = await cur.fetchall()
    rates: list[float] = []
    for run in rows:
        source_duration = run["duration_s"]
        started_at, finished_at = run["started_at"], run["finished_at"]
        if (
            source_duration is None
            or float(source_duration) <= 0
            or started_at is None
            or finished_at is None
        ):
            continue
        elapsed_s = (finished_at - started_at).total_seconds()
        if elapsed_s >= 0:
            rates.append(elapsed_s / float(source_duration))
    if not rates:
        return None
    return math.ceil(float(duration_s) * median(rates))
