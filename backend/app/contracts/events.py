"""Event payloads that cross worker, API and browser: the SSE data and run.failed."""

from pydantic import BaseModel, Field, RootModel

from app.contracts.enums import RunStatus


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


class RunEvent(RootModel[RunStatusEvent | RunProposalReadyEvent | RunDoneEvent | RunFailedEvent]):
    """One SSE ``data`` payload; the SSE event name (run.status, run.proposal_ready, run.done,
    run.failed) says which. Exists so the four payloads appear in openapi.json."""
