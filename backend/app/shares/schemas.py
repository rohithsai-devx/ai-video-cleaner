"""Share request and response models."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.contracts.enums import ShareVisibility

SLUG_PATTERN = r"^[A-Za-z0-9_-]{10,32}$"


class ShareCreate(BaseModel):
    visibility: ShareVisibility = "link"
    expires_at: datetime | None = None


class ShareCreated(BaseModel):
    slug: str = Field(pattern=SLUG_PATTERN)
    url: str


class SharePublic(BaseModel):
    title: str
    playback_url: str
    poster_url: str | None = None
