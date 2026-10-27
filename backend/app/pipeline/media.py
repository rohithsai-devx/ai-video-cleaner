"""Probe, transcode, frame, and render a recording with the ffmpeg binaries.

No model calls. AI voice muxes clips from an injected speaker; without one it keeps a silent stub.
``RecordingTooLong`` is raised from the probed duration before any transcode.
"""

import array
import asyncio
import json
import re
import sys
import tempfile
import wave
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict
from uuid import UUID

from app.contracts.enums import VoiceMode
from app.contracts.pipeline import Drop, EDLEntry, Keyframe, PreprocessResult, Proposal, ScriptBlock
from app.pipeline.segment import segment
from app.pipeline.timeline import fit_timeline
from app.pipeline.words import stub_words
from app.providers.errors import ProviderError
from app.runs.lifecycle import RunRef
from app.shared.config import MAX_RECORDING_SECONDS
from app.shared.storage import GcsStorage

# Same budget as the graph's RetryPolicy: three attempts, then the error fails the stage.
_SPEAK_ATTEMPTS = 3
Speaker = Callable[[str], tuple[bytes, float]]

# Same epsilon ``segment`` uses. Scene frames above this become segment cuts.
_SCENE = 0.3
_PTS = re.compile(r"pts_time:([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")
_SCORE = re.compile(r"lavfi\.scene_score=(\S+)")


class RecordingTooLong(Exception):
    """Probed duration is over MAX_RECORDING_SECONDS. Raised before any transcode."""

    def __init__(self, duration: float) -> None:
        self.duration = duration
        super().__init__(f"recording is {duration:.1f}s, longer than {MAX_RECORDING_SECONDS}s")


def guard_duration(duration: float) -> None:
    if duration > MAX_RECORDING_SECONDS:
        raise RecordingTooLong(duration)


@dataclass(frozen=True)
class Probe:
    duration: float
    fps: float
    rate: str
    width: int
    height: int
    has_audio: bool
    codec: str = ""


@dataclass(frozen=True)
class Sample:
    frame_id: str
    t: float
    diff: float
    path: Path


@dataclass(frozen=True)
class RenderPlan:
    entries: list[EDLEntry]
    narration: bool
    audio_seconds: float


class WaveformPeaks(TypedDict):
    rate: int
    peaks: list[float]


def plan_render(
    proposal: Proposal, *, voice: VoiceMode, audio_s_by_block: Mapping[str, float] | None = None
) -> RenderPlan:
    """Fit the edit plan to block audio. AI voice is narration, so it is never sped up."""
    narration = voice == "ai"
    drops = proposal.transcript_ctx.drops
    if narration:
        measured = audio_s_by_block or {}
        targets = {
            block.block_id: measured.get(block.block_id, block.est_dur) for block in proposal.script.blocks
        }
    else:
        targets = {block.block_id: _kept(block.source_span, drops) for block in proposal.script.blocks}
    return RenderPlan(
        entries=_fit_entries(proposal, targets, narration=narration),
        narration=narration,
        audio_seconds=sum(targets.values()),
    )


async def probe(path: Path) -> Probe:
    raw = await _exec(
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned no json for {path}") from exc
    streams = data.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise RuntimeError(f"no video stream in {path}")
    fps, rate = _rate(video)
    return Probe(
        duration=await _duration(path, data, video),
        fps=fps,
        rate=rate,
        width=int(video["width"]),
        height=int(video["height"]),
        has_audio=any(stream.get("codec_type") == "audio" for stream in streams),
        codec=str(video.get("codec_name") or ""),
    )


async def preprocess(storage: GcsStorage, run: RunRef, raw_uri: str) -> PreprocessResult:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        raw = work / "raw"
        await storage.download_to(raw_uri, raw)
        info = await probe(raw)
        guard_duration(info.duration)
        mezz = work / "mezz.mp4"
        wav = work / "audio.wav"
        await transcode(raw, mezz, wav, info)
        peaks_uri = storage.peaks_uri(run.id)
        peaks = waveform_peaks(wav)
        samples = await sample_frames(mezz, work / "frames")
        mezz_uri = storage.mezz_uri(run.id)
        audio_uri = storage.audio_uri(run.id)
        await storage.upload_file(mezz_uri, mezz, "video/mp4")
        await storage.upload_file(audio_uri, wav, "audio/wav")
        await storage.put(peaks_uri, json.dumps(peaks, separators=(",", ":")).encode(), "application/json")
        keyframes: list[Keyframe] = []
        for sample in samples:
            uri = storage.frame_uri(run.id, sample.frame_id)
            await storage.upload_file(uri, sample.path, "image/jpeg")
            keyframes.append(Keyframe(frame_id=sample.frame_id, t=sample.t, uri=uri, diff=sample.diff))
        poster = _choose_poster(samples)
        await storage.upload_file(storage.poster_uri(run.video_id), poster.path, "image/jpeg")
        return PreprocessResult(
            mezz_uri=mezz_uri,
            audio_uri=audio_uri,
            peaks_uri=peaks_uri,
            duration=info.duration,
            fps=info.fps,
            width=info.width,
            height=info.height,
            words=stub_words(info.duration),
            keyframes=keyframes,
            segments=segment(keyframes, end_s=info.duration, epsilon=_SCENE),
        )


def waveform_peaks(path: Path, *, rate: int = 50) -> WaveformPeaks:
    """Absolute maximum in each window, normalized to 0..1 from the preprocessed PCM WAV."""
    if rate <= 0:
        raise ValueError("peak rate must be positive")
    peaks: list[float] = []
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() <= 0:
            raise ValueError("waveform peaks require a mono 16-bit PCM WAV")
        frames_per_window = max(1, round(source.getframerate() / rate))
        while payload := source.readframes(frames_per_window):
            samples = array.array("h")
            samples.frombytes(payload)
            if sys.byteorder == "big":
                samples.byteswap()
            peaks.append(max(abs(value) for value in samples) / 32768.0)
    return {"rate": rate, "peaks": peaks}


async def render(
    storage: GcsStorage,
    run: RunRef,
    proposal: Proposal,
    output_uri: str,
    *,
    voice: VoiceMode,
    speaker: Speaker | None = None,
) -> None:
    clips: list[tuple[str, bytes, float]] | None = None
    if voice == "ai" and speaker is not None:
        clips = []
        for block in proposal.script.blocks:
            wav, duration = await _speak(speaker, block.text)
            clips.append((block.block_id, wav, duration))
    audio_s = None if clips is None else {block_id: duration for block_id, _wav, duration in clips}
    plan = plan_render(proposal, voice=voice, audio_s_by_block=audio_s)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        mezz = work / "mezz.mp4"
        timeline = work / "timeline.wav"
        await storage.download_to(storage.mezz_uri(run.id), mezz)
        if clips is not None:
            paths: list[Path] = []
            for index, (block_id, wav, _duration) in enumerate(clips):
                path = work / f"block-{index}.wav"
                await asyncio.to_thread(path.write_bytes, wav)
                # The block clip lands before final.mp4 so a retry overwrites a fixed key.
                await storage.upload_file(
                    _voice_uri(storage, run.id, proposal.version, block_id), path, "audio/wav"
                )
                paths.append(path)
            await _concat_wavs(paths, timeline)
        elif voice == "ai":
            await voice_stub(timeline, proposal.script.blocks)
        else:
            source = work / "audio.wav"
            await storage.download_to(storage.audio_uri(run.id), source)
            await cut_drops(source, timeline, proposal.transcript_ctx.drops)
        out = work / "final.mp4"
        await _encode(mezz, timeline, plan.entries, out)
        await storage.upload_file(output_uri, out, "video/mp4")
        poster = work / "poster.jpg"
        await _poster(out, poster)
        await storage.upload_file(storage.output_poster_uri(run.id, proposal.version), poster, "image/jpeg")


async def _speak(speaker: Speaker, text: str) -> tuple[bytes, float]:
    error: ProviderError | None = None
    for _attempt in range(_SPEAK_ATTEMPTS):
        try:
            return await asyncio.to_thread(speaker, text)
        except ProviderError as exc:
            if not exc.retryable:
                raise
            error = exc
    assert error is not None
    raise error


def _voice_uri(storage: GcsStorage, run_id: UUID, version: int, block_id: str) -> str:
    folder = storage.output_uri(run_id, version).removesuffix("final.mp4")
    return f"{folder}voice/{block_id}.wav"


async def _concat_wavs(paths: Sequence[Path], dst: Path) -> None:
    if not paths:
        await _silence(dst, 0.05)
        return
    args: list[str] = []
    labels: list[str] = []
    for index, path in enumerate(paths):
        args.extend(["-i", str(path)])
        labels.append(f"[{index}:a]")
    graph = "".join(labels) + f"concat=n={len(paths)}:v=0:a=1[a]"
    await _ffmpeg(
        *args,
        "-filter_complex",
        graph,
        "-map",
        "[a]",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(dst),
    )


async def transcode(src: Path, mezz: Path, wav: Path, info: Probe) -> None:
    await _ffmpeg(
        "-i",
        str(src),
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-r",
        info.rate,
        str(mezz),
    )
    if info.has_audio:
        await _ffmpeg("-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav))
    else:
        await _silence(wav, info.duration)


async def voice_stub(path: Path, blocks: Sequence[ScriptBlock]) -> None:
    """Silent stand-in for TTS: the clip lasts the sum of the blocks' est_dur."""
    await _silence(path, sum(block.est_dur for block in blocks))


async def cut_drops(src: Path, dst: Path, drops: Sequence[Drop]) -> None:
    af = "asetpts=N/SR/TB"
    if drops:
        terms = "+".join(
            f"between(t,{_num(start)},{_num(end)})" for start, end in (drop.span for drop in drops)
        )
        af = f"aselect='not({terms})',{af}"
    await _ffmpeg("-i", str(src), "-af", af, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst))


async def sample_frames(mezz: Path, dest: Path) -> list[Sample]:
    await asyncio.to_thread(_mkdir, dest)
    await _ffmpeg("-i", str(mezz), "-vf", _frame_filter(), "-vsync", "vfr", "f%04d.jpg", cwd=dest)
    return await asyncio.to_thread(_read_frames, dest)


def _scene_scores(text: str) -> list[tuple[float, float]]:
    pairs: list[tuple[float, float]] = []
    pending_t: float | None = None
    pending_score: float | None = None

    def flush() -> None:
        nonlocal pending_t, pending_score
        if pending_t is None:
            return
        pairs.append((pending_t, 0.0 if pending_score is None else pending_score))
        pending_t = None
        pending_score = None

    for line in text.splitlines():
        pts = _PTS.search(line)
        if pts:
            flush()
            pending_t = float(pts.group(1))
        score = _SCORE.search(line)
        if score and pending_t is not None and pending_score is None:
            raw = score.group(1)
            pending_score = 0.0 if raw.lower() == "nan" else float(raw)
    flush()
    return pairs


def _fit_entries(proposal: Proposal, targets: dict[str, float], *, narration: bool) -> list[EDLEntry]:
    # fit_timeline applies one block's audio to every entry of that block.
    # A block covers several segments, so each entry gets a share of that audio by its span.
    entries = list(proposal.edit_plan.entries)
    share: dict[int, float] = {}
    for block_id, budget in targets.items():
        group = [entry for entry in entries if entry.block_id == block_id and entry.action != "cut"]
        total = sum(entry.src[1] - entry.src[0] for entry in group)
        if total <= 0 or budget <= 0:
            continue
        for entry in group:
            span = entry.src[1] - entry.src[0]
            share[id(entry)] = budget * span / total
    fitted: list[EDLEntry] = []
    for entry in entries:
        seconds = share.get(id(entry))
        block_id = entry.block_id
        if seconds is None or block_id is None:
            fitted.append(entry)
            continue
        fitted.extend(fit_timeline([entry], proposal.seg_contexts, {block_id: seconds}, narration=narration))
    return fitted


def _kept(span: tuple[float, float], drops: Sequence[Drop]) -> float:
    start, end = span
    pieces: list[tuple[float, float]] = [(start, end)]
    for drop in drops:
        ds, de = drop.span
        nxt: list[tuple[float, float]] = []
        for left, right in pieces:
            if de <= left or ds >= right:
                nxt.append((left, right))
                continue
            if ds > left:
                nxt.append((left, min(ds, right)))
            if de < right:
                nxt.append((max(de, left), right))
        pieces = nxt
    return sum(right - left for left, right in pieces if right > left)


def _choose_poster(samples: Sequence[Sample]) -> Sample:
    changed = [sample for sample in samples if sample.diff > _SCENE]
    if changed:
        return max(changed, key=lambda sample: (sample.diff, -sample.t))
    return min(samples, key=lambda sample: (abs(sample.t - 1.0), sample.t))


def _frame_filter() -> str:
    # About 1 fps, plus frames whose scene score exceeds the segment epsilon.
    return (
        f"select='eq(n,0)+gte(t-prev_selected_t,1)+gt(scene,{_num(_SCENE)})',"
        "metadata=mode=print:file=meta.txt"
    )


def _graph(entries: Sequence[EDLEntry]) -> str:
    chains: list[str] = []
    labels: list[str] = []
    for entry in entries:
        if entry.action == "cut":
            continue
        label = f"v{len(labels)}"
        start, end = entry.src
        speed = entry.speed if entry.speed > 0 else 1.0
        steps = [
            f"trim=start={_num(start)}:end={_num(end)}",
            f"setpts=(PTS-STARTPTS)/{_num(speed)}",
        ]
        if entry.freeze_s > 0:
            steps.append(f"tpad=stop_mode=clone:stop_duration={_num(entry.freeze_s)}")
        chains.append(f"[0:v]{','.join(steps)}[{label}]")
        labels.append(f"[{label}]")
    if not labels:
        raise RuntimeError("edit plan has nothing to render")
    concat = "".join(labels) + f"concat=n={len(labels)}:v=1:a=0[v]"
    return ";".join([*chains, concat])


def _out_seconds(entries: Sequence[EDLEntry]) -> float:
    total = 0.0
    for entry in entries:
        if entry.action == "cut":
            continue
        span = entry.src[1] - entry.src[0]
        speed = entry.speed if entry.speed > 0 else 1.0
        total += span / speed + max(entry.freeze_s, 0.0)
    return total


async def _encode(mezz: Path, audio: Path, entries: Sequence[EDLEntry], out: Path) -> None:
    seconds = _out_seconds(entries)
    if seconds <= 0:
        raise RuntimeError("edit plan has nothing to render")
    graph = _graph(entries) + ";[1:a]apad[a]"
    await _ffmpeg(
        "-i",
        str(mezz),
        "-i",
        str(audio),
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        _num(seconds),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(out),
    )


async def _poster(video: Path, dest: Path) -> None:
    await _ffmpeg("-i", str(video), "-frames:v", "1", str(dest))


async def _silence(path: Path, seconds: float) -> None:
    # lavfi -t 0 writes no file.
    await _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=sample_rate=16000:channel_layout=mono",
        "-t",
        _num(max(seconds, 0.05)),
        "-c:a",
        "pcm_s16le",
        str(path),
    )


async def _ffmpeg(*args: str, cwd: Path | None = None) -> None:
    await _exec("ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args, cwd=cwd)


async def _exec(*args: str, cwd: Path | None = None) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = (stderr or stdout).decode(errors="replace")[-2000:]
        raise RuntimeError(f"{args[0]} exited {proc.returncode}: {detail}")
    return stdout


def _read_frames(dest: Path) -> list[Sample]:
    meta = dest / "meta.txt"
    text = meta.read_text() if meta.exists() else ""
    scores = _scene_scores(text)
    frames = sorted((path for path in dest.glob("f*.jpg")), key=lambda path: int(path.stem[1:]))
    if not frames:
        raise RuntimeError("ffmpeg produced no frames")
    if len(scores) != len(frames):
        raise RuntimeError(f"frame metadata count {len(scores)} != {len(frames)} images\n{text[:500]}")
    return [
        Sample(frame_id=path.stem, t=t, diff=diff, path=path)
        for path, (t, diff) in zip(frames, scores, strict=True)
    ]


async def _duration(path: Path, data: dict[str, Any], video: dict[str, Any]) -> float:
    candidates = ((data.get("format") or {}).get("duration"), video.get("duration"))
    for raw in candidates:
        if raw is None:
            continue
        duration = float(raw)
        if duration > 0:
            return duration
    # MediaRecorder webm has no duration element: read the last video packet's timestamp.
    packets = await _exec(
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time",
        "-of",
        "csv=p=0",
        str(path),
    )
    for line in reversed(packets.decode().splitlines()):
        try:
            seconds = float(line.strip())
        except ValueError:
            continue
        if seconds > 0:
            return seconds
    raise RuntimeError("ffprobe returned no duration")


def _rate(video: dict[str, Any]) -> tuple[float, str]:
    for key in ("r_frame_rate", "avg_frame_rate"):
        raw = str(video.get(key) or "")
        if "/" not in raw:
            continue
        num, den = raw.split("/", 1)
        if float(den) == 0:
            continue
        fps = float(num) / float(den)
        if fps > 0:
            return fps, raw
    raise RuntimeError("video stream has no frame rate")


def _mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _num(value: float) -> str:
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text or "0"
