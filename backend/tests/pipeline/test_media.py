"""ffmpeg preprocess and render. The 900s guard is a number. ffmpeg cases skip when the binary is absent."""

import asyncio
import io
import math
import re
import shutil
import wave
from os import PathLike, fspath
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import pytest

from app.agent.state import Bundle
from app.contracts.pipeline import (
    Drop,
    EditPlan,
    EDLEntry,
    PreprocessResult,
    Proposal,
    Script,
    ScriptBlock,
    SegContext,
    Segment,
    TranscriptContext,
)
from app.pipeline import media
from app.pipeline.media import Probe, RecordingTooLong, _duration, _scene_scores, guard_duration, plan_render
from app.pipeline.media_engines import MediaEngines
from app.pipeline.proposal_stub import stub_proposal
from app.pipeline.words import stub_words
from app.providers.bundle import Clip
from app.providers.errors import ProviderError
from app.runs.lifecycle import RunRef
from app.shared.config import MAX_RECORDING_SECONDS
from app.shared.storage import GcsStorage

_FFMPEG_MISSING = shutil.which("ffmpeg") is None
_RUN = RunRef(
    id=UUID("00000000-0000-4000-8000-000000000001"),
    workspace_id=UUID("00000000-0000-4000-8000-000000000002"),
    video_id=UUID("00000000-0000-4000-8000-000000000003"),
    status="queued",
    stage=None,
    attempt=1,
    mode="review",
    duration_s=None,
)


def test_duration_guard_rejects_over_900_seconds() -> None:
    assert MAX_RECORDING_SECONDS == 900
    assert guard_duration(900) is None
    with pytest.raises(RecordingTooLong) as raised:
        guard_duration(901)
    assert raised.value.duration == 901


def test_scene_scores_pair_time_with_diff() -> None:
    text = "\n".join(
        [
            "frame:0    pts:0       pts_time:0",
            "lavfi.scene_score=0.000000",
            "frame:1    pts:10000   pts_time:1",
            "lavfi.scene_score=0.910000",
            "frame:2    pts:20000   pts_time:2.5",
            "lavfi.scene_score=nan",
            "frame:3    pts:30000   pts_time:3",
            "frame:4    pts:40000   pts_time:4",
            "lavfi.scene_score=0.400000",
        ]
    )
    assert _scene_scores(text) == [(0.0, 0.0), (1.0, 0.91), (2.5, 0.0), (3.0, 0.0), (4.0, 0.4)]


def test_media_object_keys() -> None:
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")
    run_id = UUID("00000000-0000-4000-8000-000000000010")
    assert storage.mezz_uri(run_id) == f"gs://b/runs/{run_id}/pre/mezz.mp4"
    assert storage.audio_uri(run_id) == f"gs://b/runs/{run_id}/pre/audio.wav"
    assert storage.frame_uri(run_id, "f0001") == f"gs://b/runs/{run_id}/pre/frames/f0001.jpg"
    assert storage.output_poster_uri(run_id, 3) == f"gs://b/runs/{run_id}/post/v3/poster.jpg"


def _read(path: Path) -> bytes:
    return path.read_bytes()


def _write(path: Path, data: bytes) -> None:
    path.write_bytes(data)


async def test_file_transfer_streams_a_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    class _Blob:
        def upload_from_filename(self, filename: str, content_type: str | None = None) -> None:
            seen["upload"] = (filename, content_type)
            seen["data"] = Path(filename).read_bytes()

        def download_to_filename(self, filename: str) -> None:
            seen["download"] = filename
            Path(filename).write_bytes(seen["data"])

    def _blob(self: GcsStorage, key: str) -> _Blob:
        seen["key"] = key
        return _Blob()

    monkeypatch.setattr(GcsStorage, "_blob", _blob)
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")
    src = tmp_path / "clip.mp4"
    payload = b"mp4-bytes-not-passed-as-a-buffer"
    await asyncio.to_thread(_write, src, payload)
    uri = storage.mezz_uri("run-1")
    await storage.upload_file(uri, src, "video/mp4")
    dst = tmp_path / "out.mp4"
    await storage.download_to(uri, dst)
    assert seen["key"] == "runs/run-1/pre/mezz.mp4"
    assert seen["upload"] == (str(src), "video/mp4")
    assert seen["download"] == str(dst)
    assert await asyncio.to_thread(_read, dst) == payload
    with pytest.raises(ValueError):
        await storage.download_to("gs://other/x", dst)
    with pytest.raises(ValueError):
        await storage.upload_file("gs://other/x", src, "video/mp4")


async def test_propose_returns_the_stub() -> None:
    storage = GcsStorage(bucket="b", emulator_host="localhost:9")
    pre = PreprocessResult(
        mezz_uri="m",
        audio_uri="a",
        duration=5,
        fps=1,
        width=1,
        height=1,
        words=stub_words(5),
        keyframes=[],
        segments=[],
    )
    assert await MediaEngines(storage).propose(_RUN, pre) == stub_proposal(_RUN, pre)


def test_ai_voice_shares_audio_and_does_not_speed() -> None:
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2, parts=2)
    plan = plan_render(proposal, voice="ai")
    assert plan.narration is True
    assert plan.audio_seconds == 2
    assert [(entry.src, entry.speed, entry.freeze_s) for entry in plan.entries] == [
        ((0.0, 1.0), 1.0, 0.0),
        ((2.0, 3.0), 1.0, 0.0),
    ]


def test_ai_voice_does_not_speed_an_uncuttable_span() -> None:
    proposal = _blocks(duration=4, cuttable=False, min_dur=4, est_dur=2)
    plan = plan_render(proposal, voice="ai")
    assert plan.narration is True
    assert plan.audio_seconds == 2
    assert plan.entries[0].speed == 1
    assert plan.entries[0].src == (0.0, 4.0)
    assert plan.entries[0].freeze_s == 0


def test_ai_voice_fits_the_spoken_duration() -> None:
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2)
    plan = plan_render(proposal, voice="ai", audio_s_by_block={"b1": 0.5})
    assert plan.narration is True
    assert plan.audio_seconds == 0.5
    assert plan.entries[0].src == (0.0, 0.5)
    assert plan.entries[0].speed == 1


def test_original_voice_speeds_when_the_span_cannot_be_cut() -> None:
    proposal = _blocks(duration=4, cuttable=False, min_dur=4, est_dur=4, drops=[(2.0, 4.0)])
    plan = plan_render(proposal, voice="original")
    assert plan.narration is False
    assert plan.audio_seconds == 2
    assert plan.entries[0].speed == 2
    assert plan.entries[0].src == (0.0, 4.0)
    assert plan.entries[0].freeze_s == 0


def _write_raw(path: str) -> None:
    Path(path).write_bytes(b"x")


class _Seed(GcsStorage):
    def __init__(self) -> None:
        super().__init__(bucket="b", emulator_host="localhost:9")

    async def download_to(self, uri: str, path: str | PathLike[str]) -> None:
        del uri
        await asyncio.to_thread(_write_raw, fspath(path))


async def test_over_cap_raises_before_transcode(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_probe(path: Path) -> Probe:
        del path
        return Probe(duration=901, fps=30, rate="30/1", width=16, height=16, has_audio=True)

    async def fake_transcode(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("transcode ran")

    monkeypatch.setattr(media, "probe", fake_probe)
    monkeypatch.setattr(media, "transcode", fake_transcode)
    with pytest.raises(RecordingTooLong) as raised:
        await MediaEngines(_Seed()).preprocess(_RUN, "gs://b/videos/x/raw.webm")
    assert raised.value.duration == 901


async def test_duration_at_the_cap_reaches_transcode(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_probe(path: Path) -> Probe:
        del path
        return Probe(duration=900, fps=30, rate="30/1", width=16, height=16, has_audio=True)

    async def fake_transcode(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("stop")

    monkeypatch.setattr(media, "probe", fake_probe)
    monkeypatch.setattr(media, "transcode", fake_transcode)
    with pytest.raises(RuntimeError, match="stop"):
        await MediaEngines(_Seed()).preprocess(_RUN, "gs://b/videos/x/raw.webm")


async def test_duration_prefers_the_header_and_never_scans_packets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail(*_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("packet scan ran")

    monkeypatch.setattr(media, "_exec", fail)
    assert await _duration(Path("raw"), {"format": {"duration": "12.5"}}, {"duration": None}) == 12.5
    assert await _duration(Path("raw"), {}, {"duration": "11"}) == 11


async def test_duration_falls_back_to_the_last_video_packet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[object, ...]] = []

    async def scan(*args: object, **_kwargs: object) -> bytes:
        calls.append(args)
        return b"0.000000\n\n0.500000\n2.000000\n"

    monkeypatch.setattr(media, "_exec", scan)
    assert await _duration(Path("raw"), {}, {"duration": None}) == 2.0
    assert len(calls) == 1 and "packet=pts_time" in calls[0]

    async def empty(*_args: object, **_kwargs: object) -> bytes:
        return b""

    monkeypatch.setattr(media, "_exec", empty)
    with pytest.raises(RuntimeError, match="no duration"):
        await _duration(Path("raw"), {}, {})


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_probe_reads_packets_when_the_webm_header_has_no_duration(tmp_path: Path) -> None:
    # A non-seekable webm (what MediaRecorder produces) carries no duration element.
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x120:r=10:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=2",
        "-c:v",
        "libvpx",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    data, err = await proc.communicate()
    assert proc.returncode == 0, err.decode(errors="replace")[-2000:]
    await asyncio.to_thread(_write, tmp_path / "raw.webm", data)
    info = await media.probe(tmp_path / "raw.webm")
    assert info.duration == pytest.approx(2, abs=0.2)
    assert info.codec == "vp8"
    assert (info.width, info.height) == (160, 120)
    assert info.has_audio


class _Disk(GcsStorage):
    def __init__(self, root: Path) -> None:
        super().__init__(bucket="media-test", emulator_host="localhost:9")
        self.root = root
        self.uploads: list[str] = []

    def _local(self, uri: str) -> Path:
        key = self._own_key(uri)
        if key is None:
            raise ValueError(uri)
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def seed(self, uri: str, src: Path) -> None:
        self._local(uri).write_bytes(src.read_bytes())

    def _copy_down(self, uri: str, filename: str) -> None:
        Path(filename).write_bytes(self._local(uri).read_bytes())

    def _copy_up(self, uri: str, filename: str) -> None:
        self.uploads.append(uri)
        self._local(uri).write_bytes(Path(filename).read_bytes())

    async def download_to(self, uri: str, path: str | PathLike[str]) -> None:
        await asyncio.to_thread(self._copy_down, uri, fspath(path))

    async def upload_file(self, uri: str, path: str | PathLike[str], content_type: str) -> None:
        del content_type
        await asyncio.to_thread(self._copy_up, uri, fspath(path))


async def _bin(*args: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _stdout, err = await proc.communicate()
    assert proc.returncode == 0, err.decode(errors="replace")[-2000:]


async def _clip(path: Path) -> None:
    await _bin(
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x120:r=10:d=2",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=160x120:r=10:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=4",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(path),
    )


async def _level(path: Path, at: float) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-ss",
        f"{at:.3f}",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    raw, err = await proc.communicate()
    assert proc.returncode == 0 and raw, err.decode(errors="replace")[-500:]
    return sum(raw[:3]) / 3


def _magic(path: Path) -> bytes:
    return path.read_bytes()[:2]


def _size(path: Path) -> int:
    return path.stat().st_size


@pytest.fixture
async def preprocessed(tmp_path: Path) -> tuple[MediaEngines, _Disk, RunRef, PreprocessResult]:
    storage = _Disk(tmp_path / "obj")
    raw = tmp_path / "raw.mp4"
    await _clip(raw)
    await asyncio.to_thread(storage.seed, storage.raw_uri(_RUN.video_id), raw)
    engines = MediaEngines(storage)
    pre = await engines.preprocess(_RUN, storage.raw_uri(_RUN.video_id))
    return engines, storage, _RUN, pre


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_preprocess_transcodes_frames_and_replaces_the_poster(
    preprocessed: tuple[MediaEngines, _Disk, RunRef, PreprocessResult],
) -> None:
    _engines, storage, run, pre = preprocessed
    assert pre.duration == pytest.approx(4, abs=0.2)
    assert pre.fps == pytest.approx(10, abs=0.05)
    assert (pre.width, pre.height) == (160, 120)
    assert pre.words == stub_words(pre.duration)
    assert pre.segments[0].start == 0
    assert pre.segments[-1].end == pytest.approx(pre.duration)
    assert max(frame.diff for frame in pre.keyframes) > 0.3
    assert 3 <= len(pre.keyframes) <= 12
    mezz = await media.probe(storage._local(pre.mezz_uri))
    assert mezz.codec == "h264"
    assert mezz.fps == pytest.approx(pre.fps, rel=0.01)
    wav_size = await asyncio.to_thread(_size, storage._local(pre.audio_uri))
    assert 100_000 < wav_size < 200_000
    poster = storage._local(storage.poster_uri(run.video_id))
    assert await asyncio.to_thread(_magic, poster) == b"\xff\xd8"
    for frame in pre.keyframes:
        assert await asyncio.to_thread(_size, storage._local(frame.uri)) > 100


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_render_original_keeps_the_head_when_the_tail_is_dropped(
    preprocessed: tuple[MediaEngines, _Disk, RunRef, PreprocessResult],
) -> None:
    engines, storage, run, pre = preprocessed
    proposal = _blocks(
        duration=pre.duration,
        cuttable=True,
        min_dur=0.3,
        est_dur=pre.duration,
        drops=[(pre.duration / 2, pre.duration)],
    )
    uri = storage.output_uri(run.id, proposal.version)
    poster_uri = storage.output_poster_uri(run.id, proposal.version)
    already = len(storage.uploads)
    assert await engines.render(run, proposal, uri, voice="original") is None
    info = await media.probe(storage._local(uri))
    assert info.duration == pytest.approx(pre.duration / 2, abs=0.45)
    assert await _level(storage._local(uri), info.duration / 2) < 40
    assert storage.uploads[already:] == [uri, poster_uri]
    assert await asyncio.to_thread(_magic, storage._local(poster_uri)) == b"\xff\xd8"


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_render_original_speeds_when_audio_is_shorter(
    preprocessed: tuple[MediaEngines, _Disk, RunRef, PreprocessResult],
) -> None:
    engines, storage, run, pre = preprocessed
    proposal = _blocks(
        duration=pre.duration,
        cuttable=False,
        min_dur=pre.duration,
        est_dur=pre.duration,
        drops=[(pre.duration / 2, pre.duration)],
    )
    uri = storage.output_uri(run.id, proposal.version)
    await engines.render(run, proposal, uri, voice="original")
    info = await media.probe(storage._local(uri))
    assert info.duration == pytest.approx(pre.duration / 2, abs=0.45)
    assert await _level(storage._local(uri), info.duration * 0.8) > 180


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_render_ai_voice_does_not_speed_the_picture(
    preprocessed: tuple[MediaEngines, _Disk, RunRef, PreprocessResult],
) -> None:
    engines, storage, run, pre = preprocessed
    proposal = _blocks(duration=pre.duration, cuttable=False, min_dur=pre.duration, est_dur=pre.duration / 2)
    uri = storage.output_uri(run.id, proposal.version)
    await engines.render(run, proposal, uri, voice="ai")
    info = await media.probe(storage._local(uri))
    assert info.duration == pytest.approx(pre.duration, abs=0.45)
    assert await _level(storage._local(uri), info.duration * 0.8) > 180


def _blocks(
    *,
    duration: float,
    cuttable: bool,
    min_dur: float,
    est_dur: float,
    parts: int = 1,
    drops: list[tuple[float, float]] | None = None,
) -> Proposal:
    step = duration / parts
    segments = [
        Segment(
            seg_id=f"seg_{index + 1:02d}",
            start=index * step,
            end=(index + 1) * step,
            frame_ids=[],
            active=cuttable,
        )
        for index in range(parts)
    ]
    contexts = [
        SegContext(
            seg_id=seg.seg_id,
            label="s",
            reasoning="",
            cuttable=cuttable,
            min_dur=min_dur if parts == 1 else min(min_dur, step),
            max_dur=seg.end - seg.start,
            max_speed=2,
            by="code",
        )
        for seg in segments
    ]
    entries = [
        EDLEntry(
            seg_id=seg.seg_id,
            src=(seg.start, seg.end),
            action="keep",
            speed=1,
            freeze_s=0,
            block_id="b1",
            reasoning="",
        )
        for seg in segments
    ]
    block = ScriptBlock(
        block_id="b1",
        text="word",
        seg_ids=[seg.seg_id for seg in segments],
        source_span=(0.0, duration),
        target_min=min_dur,
        target_max=duration,
        est_dur=est_dur,
    )
    return Proposal(
        run_id=str(_RUN.id),
        version=1,
        source="agent",
        script=Script(blocks=[block]),
        edit_plan=EditPlan(entries=entries),
        seg_contexts=contexts,
        transcript_ctx=TranscriptContext(
            steps=[],
            key_terms=[],
            drops=[Drop(span=span, kind="filler", reason="um") for span in drops or []],
        ),
        checks=[],
        flags=[],
    )


def _two_blocks() -> Proposal:
    base = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2, parts=2)
    first, second = base.edit_plan.entries
    sample = base.script.blocks[0]
    return base.model_copy(
        update={
            "script": Script(
                blocks=[
                    sample.model_copy(update={"block_id": "b1", "text": "alpha", "seg_ids": ["seg_01"]}),
                    sample.model_copy(update={"block_id": "b2", "text": "beta", "seg_ids": ["seg_02"]}),
                ]
            ),
            "edit_plan": EditPlan(
                entries=[
                    first.model_copy(update={"block_id": "b1"}),
                    second.model_copy(update={"block_id": "b2"}),
                ]
            ),
        }
    )


class _Mem(GcsStorage):
    def __init__(self) -> None:
        super().__init__(bucket="b", emulator_host="localhost:9")
        self.objects: dict[str, bytes] = {}
        self.uploads: list[str] = []

    async def download_to(self, uri: str, path: str | PathLike[str]) -> None:
        payload = self.objects[uri]
        await asyncio.to_thread(Path(path).write_bytes, payload)

    async def upload_file(self, uri: str, path: str | PathLike[str], content_type: str) -> None:
        del content_type
        payload = await asyncio.to_thread(Path(path).read_bytes)
        self.objects[uri] = payload
        self.uploads.append(uri)


def _quiet_render(monkeypatch: pytest.MonkeyPatch, seen: dict[str, Any]) -> None:
    async def encode(mezz: Path, audio: Path, entries: list[Any], out: Path) -> None:
        del mezz, audio
        seen["entries"] = entries
        await asyncio.to_thread(out.write_bytes, b"mp4")

    async def poster(video: Path, dest: Path) -> None:
        del video
        await asyncio.to_thread(dest.write_bytes, b"\xff\xd8")

    async def concat(paths: list[Path], dst: Path) -> None:
        del paths
        await asyncio.to_thread(dst.write_bytes, b"wav")

    async def cut(src: Path, dst: Path, drops: list[Any]) -> None:
        del src
        seen["drops"] = drops
        await asyncio.to_thread(dst.write_bytes, b"cut")

    monkeypatch.setattr(media, "_encode", encode)
    monkeypatch.setattr(media, "_poster", poster)
    monkeypatch.setattr(media, "_concat_wavs", concat)
    monkeypatch.setattr(media, "cut_drops", cut)


class _Clips:
    def __init__(self, clips: dict[str, tuple[bytes, float]]) -> None:
        self.clips = clips
        self.texts: list[str] = []
        self.voice_id: str | None = None
        self.pronunciations: dict[str, str] | None = None
        self.stage: str | None = None

    def synthesize(self, call: Any, text: str, voice_id: str, pronunciations: dict[str, str]) -> Clip:
        self.texts.append(text)
        self.voice_id = voice_id
        self.pronunciations = pronunciations
        self.stage = call.stage
        wav, duration = self.clips[text]
        return Clip(audio=wav, duration_s=duration)


class _Fails:
    def __init__(self, *, times: int, retryable: bool, then: tuple[bytes, float] | None = None) -> None:
        self.times = times
        self.retryable = retryable
        self.then = then
        self.calls = 0

    def synthesize(self, call: Any, text: str, voice_id: str, pronunciations: dict[str, str]) -> Clip:
        del call, text, voice_id, pronunciations
        self.calls += 1
        if self.calls <= self.times:
            raise ProviderError("busy", retryable=self.retryable)
        assert self.then is not None
        wav, duration = self.then
        return Clip(audio=wav, duration_s=duration)


def _engines(storage: GcsStorage, bundle: object) -> MediaEngines:
    return MediaEngines(storage, bundle=cast(Bundle, bundle))


async def test_ai_render_writes_each_block_and_fits_its_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _quiet_render(monkeypatch, seen)
    storage = _Mem()
    storage.objects[storage.mezz_uri(_RUN.id)] = b"mezz"
    speech = _Clips({"alpha": (b"wav-alpha", 0.4), "beta": (b"wav-beta", 1.25)})
    proposal = _two_blocks()
    uri = storage.output_uri(_RUN.id, proposal.version)
    await _engines(storage, speech).render(_RUN, proposal, uri, voice="ai")
    b1 = f"gs://b/runs/{_RUN.id}/post/v1/voice/b1.wav"
    b2 = f"gs://b/runs/{_RUN.id}/post/v1/voice/b2.wav"
    assert speech.texts == ["alpha", "beta"]
    assert speech.stage == "voice"
    assert speech.voice_id == ""
    assert speech.pronunciations == {}
    assert storage.objects[b1] == b"wav-alpha"
    assert storage.objects[b2] == b"wav-beta"
    assert storage.uploads.index(b1) < storage.uploads.index(uri)
    assert storage.uploads.index(b2) < storage.uploads.index(uri)
    assert [(entry.src, entry.speed) for entry in seen["entries"]] == [((0.0, 0.4), 1.0), ((2.0, 3.25), 1.0)]


async def test_retryable_speech_error_is_tried_three_times() -> None:
    speech = _Fails(times=3, retryable=True)
    storage = _Mem()
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2)
    with pytest.raises(ProviderError, match="busy"):
        await _engines(storage, speech).render(_RUN, proposal, storage.output_uri(_RUN.id, 1), voice="ai")
    assert speech.calls == 3
    assert storage.uploads == []


async def test_speech_recovers_on_the_third_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    _quiet_render(monkeypatch, {})
    storage = _Mem()
    storage.objects[storage.mezz_uri(_RUN.id)] = b"mezz"
    speech = _Fails(times=2, retryable=True, then=(b"wav-ok", 0.5))
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2)
    uri = storage.output_uri(_RUN.id, proposal.version)
    await _engines(storage, speech).render(_RUN, proposal, uri, voice="ai")
    assert speech.calls == 3
    voice = f"gs://b/runs/{_RUN.id}/post/v1/voice/b1.wav"
    assert storage.objects[voice] == b"wav-ok"
    assert storage.uploads.index(voice) < storage.uploads.index(uri)


async def test_terminal_speech_error_is_not_retried() -> None:
    speech = _Fails(times=1, retryable=False)
    storage = _Mem()
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=2)
    with pytest.raises(ProviderError, match="busy"):
        await _engines(storage, speech).render(_RUN, proposal, storage.output_uri(_RUN.id, 1), voice="ai")
    assert speech.calls == 1
    assert storage.uploads == []


async def test_original_voice_cuts_the_wav_and_does_not_speak(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _quiet_render(monkeypatch, seen)
    storage = _Mem()
    storage.objects[storage.mezz_uri(_RUN.id)] = b"mezz"
    storage.objects[storage.audio_uri(_RUN.id)] = b"audio"
    speech = _Fails(times=1, retryable=False)
    proposal = _blocks(duration=4, cuttable=True, min_dur=0.3, est_dur=4, drops=[(1.0, 2.0)])
    uri = storage.output_uri(_RUN.id, proposal.version)
    await _engines(storage, speech).render(_RUN, proposal, uri, voice="original")
    assert speech.calls == 0
    assert seen["drops"][0].span == (1.0, 2.0)
    assert not any("/voice/" in item for item in storage.uploads)
    assert uri in storage.uploads


def _tone(seconds: float) -> bytes:
    buf = io.BytesIO()
    rate = 16000
    count = int(rate * seconds)
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        frames = bytearray()
        for index in range(count):
            sample = int(12000 * math.sin(2 * math.pi * 440 * index / rate))
            frames += sample.to_bytes(2, "little", signed=True)
        handle.writeframes(frames)
    return buf.getvalue()


async def _mean_volume(path: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _out, err = await proc.communicate()
    text = err.decode(errors="replace")
    assert proc.returncode == 0, text[-500:]
    match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", text)
    assert match is not None, text[-500:]
    return float(match.group(1))


@pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg is not on PATH")
async def test_ai_voice_muxes_the_spoken_clip(
    preprocessed: tuple[MediaEngines, _Disk, RunRef, PreprocessResult],
) -> None:
    _engines_stub, storage, run, pre = preprocessed
    tone = _tone(0.5)
    speech = _Clips({"word": (tone, 0.5)})
    proposal = _blocks(duration=pre.duration, cuttable=True, min_dur=0.3, est_dur=pre.duration)
    uri = storage.output_uri(run.id, proposal.version)
    await _engines(storage, speech).render(run, proposal, uri, voice="ai")
    info = await media.probe(storage._local(uri))
    assert info.duration == pytest.approx(0.5, abs=0.35)
    assert await _mean_volume(storage._local(uri)) > -30
    voice_uri = next(item for item in storage.uploads if item.endswith("/voice/b1.wav"))
    assert storage.uploads.index(voice_uri) < storage.uploads.index(uri)
    assert await asyncio.to_thread(storage._local(voice_uri).read_bytes) == tone
