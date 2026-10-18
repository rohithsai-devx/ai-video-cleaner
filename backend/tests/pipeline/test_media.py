"""ffmpeg preprocess and render. The 900s guard is a number. ffmpeg cases skip when the binary is absent."""

import asyncio
import shutil
from os import fspath
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

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
from app.pipeline.media import Probe, RecordingTooLong, _scene_scores, guard_duration, plan_render
from app.pipeline.media_engines import MediaEngines
from app.pipeline.proposal_stub import stub_proposal
from app.pipeline.words import stub_words
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

    async def download_to(self, uri: str, path: str | Path) -> None:
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

    async def download_to(self, uri: str, path: str | Path) -> None:
        await asyncio.to_thread(self._copy_down, uri, fspath(path))

    async def upload_file(self, uri: str, path: str | Path, content_type: str) -> None:
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
            glossary=[],
            drops=[Drop(span=span, kind="filler", reason="um") for span in drops or []],
        ),
        checks=[],
        flags=[],
    )
