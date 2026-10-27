"""Video request and response models."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.contracts.enums import VideoStatus
from app.runs.schemas import RunSummary


class Page[T](BaseModel):
    items: list[T]
    next_cursor: str | None = None


class VideoCreate(BaseModel):
    title: str = Field(default="Untitled recording", min_length=1, max_length=200)


class VideoCreated(BaseModel):
    video_id: str
    upload_url: str
    poster_upload_url: str | None = None  # null if the poster session could not be opened


class VideoUploaded(BaseModel):
    """Optional metadata the recorder knows at upload time; all fields may be omitted."""

    duration_s: float | None = Field(default=None, gt=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    fps: float | None = Field(default=None, gt=0)


class Video(BaseModel):
    id: str
    workspace_id: str
    title: str
    status: VideoStatus
    duration_s: float | None = None
    estimated_run_seconds: int | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    created_at: datetime
    updated_at: datetime
    current_run: RunSummary | None = None
    playback_url: str | None = None
    poster_url: str | None = None
    original_url: str | None = None
    download_url: str | None = None
    original_download_url: str | None = None
