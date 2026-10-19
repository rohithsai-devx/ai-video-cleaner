"""The bundle the rest of the app calls. Plugins own the HTTP."""

import time
from base64 import b64encode
from collections.abc import Callable
from typing import Any, NoReturn

import httpx
from pydantic import BaseModel

from app.contracts.pipeline import SegContext
from app.providers.errors import ProviderError
from app.providers.laya import CHECKPOINT, Decision, decide
from app.providers.openai import chat, describe, open_client, synthesize
from app.shared.config import Settings


class Call(BaseModel):
    workspace_id: str
    run_id: str
    stage: str


class CallLog(BaseModel):
    provider: str
    model: str
    stage: str
    workspace_id: str
    run_id: str
    ok: bool
    latency_ms: int


class Clip(BaseModel):
    audio: bytes
    duration_s: float


Recorder = Callable[[CallLog], None]
FrameReader = Callable[[str], bytes]


class Providers:
    def __init__(
        self,
        settings: Settings,
        openai_http: httpx.Client,
        gemma_http: httpx.Client,
        frame_reader: FrameReader | None,
        recorder: Recorder,
    ) -> None:
        self._settings = settings
        self._openai_http = openai_http
        self._gemma_http = gemma_http
        self._frame_reader = frame_reader
        self._recorder = recorder

    def complete[T: BaseModel](
        self,
        call: Call,
        messages: list[Any],
        schema: type[T],
        tools: list[dict[str, Any]] | None = None,
    ) -> T:
        model = self._settings.openai_chat_model
        started = time.perf_counter()
        ok = False
        try:
            result = chat(
                self._openai_http,
                base_url=self._settings.openai_base_url,
                model=model,
                messages=messages,
                schema=schema,
                tools=tools,
            )
            ok = True
            return result
        finally:
            self._log(call, "openai", model, ok, started)

    def describe(
        self,
        call: Call,
        frame_uris: list[str],
        transcript: str,
        hints: dict[str, Any],
    ) -> SegContext:
        started = time.perf_counter()
        ok = False
        try:
            if not self._settings.gemma_base_url.strip():
                raise ProviderError("GEMMA_BASE_URL is empty", retryable=False)
            result = describe(
                self._gemma_http,
                base_url=self._settings.gemma_base_url,
                frame_urls=[self._frame_url(uri) for uri in frame_uris],
                model=self._settings.gemma_model,
                transcript=transcript,
                hints=hints,
            )
            ok = True
            return result
        finally:
            self._log(call, "gemma", self._settings.gemma_model, ok, started)

    def _frame_url(self, uri: str) -> str:
        if not uri.startswith("gs://"):
            return uri
        if self._frame_reader is None:
            raise ProviderError("GCS frame reader is not configured", retryable=False)
        image = self._frame_reader(uri)
        return f"data:image/jpeg;base64,{b64encode(image).decode('ascii')}"

    def synthesize(
        self,
        call: Call,
        text: str,
        voice_id: str,
        pronunciations: dict[str, str],
    ) -> Clip:
        # ponytail: pronunciations are accepted and unused until ElevenLabs.
        del pronunciations
        voice = voice_id or self._settings.openai_speech_voice
        model = self._settings.openai_speech_model
        started = time.perf_counter()
        ok = False
        try:
            audio, duration_s = synthesize(
                self._openai_http,
                base_url=self._settings.openai_base_url,
                model=model,
                voice=voice,
                text=text,
            )
            ok = True
            return Clip(audio=audio, duration_s=duration_s)
        finally:
            self._log(call, "openai", model, ok, started)

    def transcribe(self, call: Call, audio_uri: str) -> NoReturn:
        del audio_uri
        self._log(call, "elevenlabs", "", False, time.perf_counter())
        raise ProviderError("speech-to-text waits for ElevenLabs", retryable=False)

    def yes_no(self, call: Call, question: str, ctx: str) -> Decision:
        started = time.perf_counter()
        ok = False
        try:
            decision = decide(question, ctx)
            ok = True
            return decision
        finally:
            self._log(call, "laya", CHECKPOINT, ok, started)

    def _log(self, call: Call, provider: str, model: str, ok: bool, started: float) -> None:
        self._recorder(
            CallLog(
                provider=provider,
                model=model,
                stage=call.stage,
                workspace_id=call.workspace_id,
                run_id=call.run_id,
                ok=ok,
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        )


def build(
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
    frame_reader: FrameReader | None = None,
    recorder: Recorder | None = None,
) -> Providers:
    return Providers(
        settings,
        open_client(settings.openai_api_key, transport),
        open_client(settings.gemma_bearer_token, transport),
        frame_reader,
        recorder or (lambda _row: None),
    )
