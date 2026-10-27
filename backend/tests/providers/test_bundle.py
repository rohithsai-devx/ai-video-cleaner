"""OpenAI chat and speech, played back through a fake transport. No live network."""

import ast
import base64
import io
import json
import wave
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from app.contracts.pipeline import SegContext
from app.providers import Call, CallLog, ProviderError, build
from app.shared.config import Settings

APP = Path(__file__).resolve().parents[2] / "app"
RATE = 16_000
FRAMES = 12_345


class Label(BaseModel):
    label: str


def _settings(**overrides: Any) -> Settings:
    data: dict[str, Any] = {
        "database_url_api": "postgresql://app_api@localhost/avc",
        "jwt_secret": "k" * 16,
        "openai_api_key": "test-key",
        "openai_base_url": "https://api.openai.com/v1",
        "openai_chat_model": "gpt-6-luna",
        "openai_speech_model": "gpt-4o-mini-tts-2025-12-15",
        "openai_speech_voice": "coral",
        "gemma_base_url": "",
        "gemma_api_key": "",
        "gemma_model": "gemma-4",
        "modal_proxy_token_id": "",
        "modal_proxy_token_secret": "",
    }
    data.update(overrides)
    return Settings(**data)


def _call() -> Call:
    return Call(workspace_id="ws", run_id="run", stage="script_writer")


def _transport(status: int, body: bytes) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, content=body)

    return httpx.MockTransport(handler), seen


def _chat(obj: dict[str, Any]) -> bytes:
    return json.dumps({"choices": [{"message": {"role": "assistant", "content": json.dumps(obj)}}]}).encode()


def _wav(rate: int, frames: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def test_complete_returns_the_schema_instance() -> None:
    transport, seen = _transport(200, _chat({"label": "keep"}))
    providers = build(_settings(), transport=transport)
    got = providers.complete(_call(), [{"role": "user", "content": "hi"}], Label)
    assert got == Label(label="keep")
    assert len(seen) == 1
    assert seen[0].url.path == "/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer test-key"
    body = json.loads(seen[0].content)
    assert body["model"] == "gpt-6-luna"
    assert body["reasoning_effort"] == "low"
    assert "tools" not in body


def test_tools_set_reasoning_effort_none() -> None:
    transport, seen = _transport(200, _chat({"label": "keep"}))
    tools = [{"type": "function", "function": {"name": "compare_frames"}}]
    build(_settings(), transport=transport).complete(_call(), [], Label, tools=tools)
    body = json.loads(seen[0].content)
    assert body["reasoning_effort"] == "none"
    assert body["tools"] == tools


@pytest.mark.parametrize("status", [429, 500])
def test_429_and_5xx_are_retryable(status: int) -> None:
    transport, seen = _transport(status, b"")
    with pytest.raises(ProviderError) as exc:
        build(_settings(), transport=transport).complete(_call(), [], Label)
    assert exc.value.retryable is True
    assert len(seen) == 1


def test_timeout_is_retryable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with pytest.raises(ProviderError) as exc:
        build(_settings(), transport=httpx.MockTransport(handler)).complete(_call(), [], Label)
    assert exc.value.retryable is True


def test_non_schema_body_is_not_retryable() -> None:
    transport, seen = _transport(200, _chat({"nope": True}))
    with pytest.raises(ProviderError) as exc:
        build(_settings(), transport=transport).complete(_call(), [], Label)
    assert exc.value.retryable is False
    assert len(seen) == 1


def test_gemma_uses_its_own_key_and_embeds_gcs_frame_data() -> None:
    image = b"jpeg-frame"
    seg = SegContext(
        seg_id="s1",
        label="Settings page",
        reasoning="A settings page is visible.",
        cuttable=False,
        min_dur=1.0,
        max_dur=4.0,
        max_speed=2.0,
        by="vlm",
    )
    transport, seen = _transport(200, _chat(seg.model_dump()))
    loaded: list[str] = []
    providers = build(
        _settings(
            openai_api_key="openai-secret",
            gemma_api_key="modal-proxy-secret",
            gemma_base_url="https://gemma.example/v1",
            gemma_model="gemma4-e4b-vlm",
        ),
        transport=transport,
        frame_reader=lambda uri: loaded.append(uri) or image,
    )

    result = providers.describe(_call(), ["gs://avc-local/frame.jpg"], "word", {"seg_id": "s1"})

    assert result == seg
    assert loaded == ["gs://avc-local/frame.jpg"]
    assert seen[0].headers["authorization"] == "Bearer modal-proxy-secret"
    body = json.loads(seen[0].content)
    assert body["model"] == "gemma4-e4b-vlm"
    image_url = body["messages"][0]["content"][1]["image_url"]["url"]
    assert image_url == f"data:image/jpeg;base64,{base64.b64encode(image).decode()}"


def test_modal_proxy_token_pair_authenticates_gemma_request() -> None:
    seg = SegContext(
        seg_id="s1",
        label="A red button",
        reasoning="The image shows a red button.",
        cuttable=False,
        min_dur=1.0,
        max_dur=4.0,
        max_speed=2.0,
        by="vlm",
    )
    transport, seen = _transport(200, _chat(seg.model_dump()))
    providers = build(
        _settings(
            gemma_base_url="https://gemma.example/v1",
            modal_proxy_token_id="wk-test-id",
            modal_proxy_token_secret="ws-test-secret",
            gemma_model="Qwen/Qwen3.8-Max-VL-Thinking",
        ),
        transport=transport,
        frame_reader=lambda _uri: b"jpeg-frame",
    )

    assert providers.describe(_call(), ["gs://avc-local/frame.jpg"], "What color is the button?", {}) == seg
    assert seen[0].headers["authorization"] == "Bearer wk-test-id.ws-test-secret"
    body = json.loads(seen[0].content)
    assert body["model"] == "Qwen/Qwen3.8-Max-VL-Thinking"
    assert body["response_format"]["type"] == "json_schema"
    assert body["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_partial_modal_proxy_token_pair_fails_before_request() -> None:
    with pytest.raises(ValueError, match="set both MODAL_PROXY_TOKEN_ID"):
        build(_settings(modal_proxy_token_id="wk-test-id"), transport=_transport(200, _chat({}))[0])


def test_gemma_refuses_gcs_uri_without_a_frame_reader() -> None:
    transport, seen = _transport(200, _chat({}))
    providers = build(_settings(gemma_base_url="https://gemma.example/v1"), transport=transport)

    with pytest.raises(ProviderError, match="GCS frame reader"):
        providers.describe(_call(), ["gs://avc-local/frame.jpg"], "word", {})
    assert seen == []


def test_empty_gemma_url_does_not_call_http() -> None:
    transport, seen = _transport(200, _chat({}))
    with pytest.raises(ProviderError, match="GEMMA_BASE_URL") as exc:
        build(_settings(), transport=transport).describe(_call(), ["gs://bucket/f.jpg"], "hello", {})
    assert exc.value.retryable is False
    assert seen == []


def test_synthesize_duration_comes_from_the_wav() -> None:
    audio = _wav(RATE, FRAMES)
    transport, seen = _transport(200, audio)
    clip = build(_settings(), transport=transport).synthesize(_call(), "Hello", "")
    assert clip.audio == audio
    assert clip.duration_s == FRAMES / RATE
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/audio/speech"
    assert body["model"] == "gpt-4o-mini-tts-2025-12-15"
    assert body["response_format"] == "wav"
    assert body["voice"] == "coral"


def test_synthesize_measures_the_payload_not_the_streamed_header() -> None:
    # OpenAI streams the speech wav with placeholder sizes (0xffffffff); the header's
    # nframes then reads as INT32_MAX and a header-trusting parse measures ~24 hours.
    audio = bytearray(_wav(RATE, FRAMES))
    audio[4:8] = b"\xff\xff\xff\xff"
    data_size = bytes(audio).find(b"data") + 4
    audio[data_size : data_size + 4] = b"\xff\xff\xff\xff"
    transport, _seen = _transport(200, bytes(audio))
    clip = build(_settings(), transport=transport).synthesize(_call(), "Hello", "")
    assert clip.duration_s == FRAMES / RATE


def test_recorder_gets_one_row_for_a_successful_complete() -> None:
    rows: list[CallLog] = []
    transport, _seen = _transport(200, _chat({"label": "keep"}))
    build(_settings(), transport=transport, recorder=rows.append).complete(_call(), [], Label)
    assert len(rows) == 1
    row = rows[0]
    assert row.provider == "openai"
    assert row.model == "gpt-6-luna"
    assert row.stage == "script_writer"
    assert row.workspace_id == "ws"
    assert row.run_id == "run"
    assert row.ok is True
    assert row.latency_ms >= 0


def test_transcribe_waits_for_elevenlabs() -> None:
    providers = build(_settings(), transport=_transport(200, b"")[0])
    with pytest.raises(ProviderError, match="ElevenLabs") as stt:
        providers.transcribe(_call(), "gs://bucket/a.wav")
    assert stt.value.retryable is False


def test_providers_do_not_import_pipeline_agent_runs_or_laya() -> None:
    banned_roots = {"laya", "laya_mlx", "mlx", "psycopg"}
    for path in (APP / "providers").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            modules: list[str] = []
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                modules = [node.module]
            for name in modules:
                assert name.split(".")[0] not in banned_roots
                parts = name.split(".")
                assert parts[:2] != ["app", "pipeline"]
                assert parts[:2] != ["app", "agent"]
                assert parts[:2] != ["app", "runs"]
