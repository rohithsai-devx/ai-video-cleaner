"""OpenAI and OpenAI-compatible Gemma calls. One POST each; no retry and no sleep."""

import io
import json
import wave
from typing import Any

import httpx
from pydantic import BaseModel, SecretStr, ValidationError

from app.contracts.pipeline import SegContext
from app.providers.errors import ProviderError


def open_client(api_key: SecretStr, transport: httpx.BaseTransport | None) -> httpx.Client:
    headers: dict[str, str] = {}
    key = api_key.get_secret_value()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return httpx.Client(transport=transport, headers=headers, timeout=60.0, trust_env=False)


def chat[T: BaseModel](
    client: httpx.Client,
    *,
    base_url: str,
    model: str,
    messages: list[Any],
    schema: type[T],
    tools: list[dict[str, Any]] | None = None,
    reasoning: bool = True,
) -> T:
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": schema.model_json_schema()},
        },
    }
    if reasoning:
        # gpt-6-luna accepts tools only with reasoning_effort none.
        body["reasoning_effort"] = "none" if tools else "low"
    if tools:
        body["tools"] = tools
    response = _post(client, _join(base_url, "chat/completions"), body)
    return _parse(response, schema)


def describe(
    client: httpx.Client,
    *,
    base_url: str,
    frame_urls: list[str],
    model: str,
    transcript: str,
    hints: dict[str, Any],
) -> SegContext:
    if not base_url.strip():
        raise ProviderError("GEMMA_BASE_URL is empty", retryable=False)
    content: list[dict[str, Any]] = [
        {"type": "text", "text": json.dumps({"transcript": transcript, "hints": hints})},
        *[{"type": "image_url", "image_url": {"url": url}} for url in frame_urls],
    ]
    return chat(
        client,
        base_url=base_url,
        model=model,
        messages=[{"role": "user", "content": content}],
        schema=SegContext,
        reasoning=False,
    )


def synthesize(
    client: httpx.Client,
    *,
    base_url: str,
    model: str,
    voice: str,
    text: str,
) -> tuple[bytes, float]:
    response = _post(
        client,
        _join(base_url, "audio/speech"),
        {"model": model, "voice": voice, "input": text, "response_format": "wav"},
    )
    audio = response.content
    return audio, _wav_seconds(audio)


def _join(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{path}"


def _post(client: httpx.Client, url: str, body: dict[str, Any]) -> httpx.Response:
    try:
        response = client.post(url, json=body)
    except httpx.TimeoutException as exc:
        raise ProviderError("provider timed out", retryable=True) from exc
    except httpx.RequestError as exc:
        raise ProviderError("provider request failed", retryable=True) from exc
    if response.status_code == 429 or response.status_code >= 500:
        raise ProviderError(f"provider returned {response.status_code}", retryable=True)
    if response.status_code >= 400:
        raise ProviderError(f"provider returned {response.status_code}", retryable=False)
    return response


def _parse[T: BaseModel](response: httpx.Response, schema: type[T]) -> T:
    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ProviderError("response is not the schema", retryable=False) from exc
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    try:
        if isinstance(content, str):
            return schema.model_validate_json(content)
        return schema.model_validate(content)
    except ValidationError as exc:
        raise ProviderError("response is not the schema", retryable=False) from exc


def _wav_seconds(audio: bytes) -> float:
    try:
        with wave.open(io.BytesIO(audio)) as wf:
            rate = wf.getframerate()
            width = wf.getsampwidth()
            channels = wf.getnchannels()
            # Streamed wavs carry placeholder sizes (OpenAI writes 0xffffffff), so the header's
            # nframes can lie; the payload that was actually sent is the truth.
            payload = wf.readframes(wf.getnframes())
    except wave.Error as exc:
        raise ProviderError("speech response is not a wav", retryable=False) from exc
    if rate <= 0 or width <= 0 or channels <= 0:
        raise ProviderError("wav sample rate is zero", retryable=False)
    frames = len(payload) // (width * channels)
    if frames <= 0:
        raise ProviderError("wav has no samples", retryable=False)
    return frames / rate
