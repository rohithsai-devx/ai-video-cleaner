"""Event payloads that cross worker, API and browser: the SSE data and run.failed."""

from pydantic import BaseModel, Field, RootModel

from app.contracts.enums import RunStatus
from app.contracts.pipeline import Chapter


class RunFailedEvent(BaseModel):
    """Payload of the run.failed event; also the shape of Run.error."""

    stage: str
    message: str
    retryable: bool


class RunStatusEvent(BaseModel):
    status: RunStatus
    stage: str | None = None


class RunProposalReadyEvent(BaseModel):
    version: int = Field(ge=1)
    flags: list[str] = []
    auto_approved: bool


class RunDoneEvent(BaseModel):
    video_id: str
    output_uri: str  # signed playback URL, never a raw gs:// URI
    share_slug: str | None = None


class RunProgressEvent(BaseModel):
    pauses: int | None = None
    filler: int | None = None
    retakes: int | None = None
    slow_parts: int | None = None
    chapters: list[Chapter] = Field(default_factory=list)


class RunEvent(
    RootModel[RunStatusEvent | RunProposalReadyEvent | RunDoneEvent | RunFailedEvent | RunProgressEvent]
):
    """One SSE payload; the event name says which progress or lifecycle shape it carries."""
