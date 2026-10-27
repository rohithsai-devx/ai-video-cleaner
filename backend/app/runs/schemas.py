"""Run request, response and proposal-review models."""

from datetime import datetime
from typing import Self

from pydantic import BaseModel, Field, model_validator

from app.contracts.enums import RunMode, RunStatus, VoiceMode
from app.contracts.events import RunFailedEvent
from app.contracts.pipeline import EditPlan, FixOptions, Proposal, Script, SegContext


class RunSummary(BaseModel):
    run_id: str
    status: RunStatus
    stage: str | None = None


class RunListItem(BaseModel):
    run_id: str
    status: RunStatus
    created_at: datetime
    voice: VoiceMode
    voice_id: str | None
    needs_you: int = 0


class VoiceOption(BaseModel):
    id: str
    label: str
    hint: str
    sample_path: str


class VoiceList(BaseModel):
    default_voice_id: str
    voices: list[VoiceOption]


class RunCreate(BaseModel):
    mode: RunMode
    voice: VoiceMode
    voice_id: str | None = Field(default=None, min_length=1)
    fix_options: FixOptions = Field(default_factory=FixOptions)

    @model_validator(mode="after")
    def _voice_id_iff_ai(self) -> Self:
        if (self.voice == "ai") != (self.voice_id is not None):
            raise ValueError("voice_id is required when voice is 'ai' and must be omitted otherwise")
        return self


class RunCreated(BaseModel):
    run_id: str


class Run(BaseModel):
    id: str
    video_id: str
    mode: RunMode
    voice: VoiceMode
    voice_id: str | None = None
    fix_options: FixOptions = Field(default_factory=FixOptions)
    status: RunStatus
    stage: str | None = None
    attempt: int = Field(ge=1)
    flags: list[str] = []
    error: RunFailedEvent | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class ProposalUpdate(BaseModel):
    base_version: int = Field(description="The version this edit was made on; 409 version_conflict if stale.")
    script: Script
    edit_plan: EditPlan
    seg_contexts: list[SegContext]


class ApproveRequest(BaseModel):
    base_version: int | None = Field(
        default=None, description="Version being approved; 409 version_conflict if stale; omit for latest."
    )


class KeyframeThumb(BaseModel):
    frame_id: str
    t: float
    url: str  # signed URL, never a gs:// URI


class ProposalView(BaseModel):
    """GET/PUT /runs/{id}/proposal: the latest proposal plus keyframe thumbnail URLs."""

    proposal: Proposal
    keyframes: list[KeyframeThumb] = []
