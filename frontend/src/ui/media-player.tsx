"use client";

import { FastForward, Pause, Play, Rewind } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { formatClock, formatRate } from "@/lib/clock";
import { outputLength, toOutputTime, toSourceTime, type PlayerSegment } from "@/lib/cut-map";
import { Button } from "./button";
import { cx } from "./cx";

export type PlayerProps = {
  src: string;
  duration: number;
  mode: "cleaned-preview" | "file";
  segments?: PlayerSegment[];
  chapters?: { title: string; start: number }[];
  badge?: string;
  onTime?: (t: number) => void;
  /** A controlled seek in source time. Pass a new object per request, so the same time can seek twice. */
  seekTo?: { time: number };
};

function clamp(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Number.isFinite(value) ? value : 0));
}

function percent(time: number, duration: number): number {
  return duration > 0 ? (clamp(time, duration) / duration) * 100 : 0;
}

function removedAt(time: number, segments: PlayerSegment[]): PlayerSegment | undefined {
  return segments.find(
    (segment) => segment.kind === "removed" && time >= segment.start && time < segment.end,
  );
}

function speedAt(time: number, segments: PlayerSegment[]): PlayerSegment | undefined {
  return segments.find(
    (segment) => segment.kind === "speed" && time >= segment.start && time < segment.end,
  );
}

export function MediaPlayer({
  src,
  duration: givenDuration,
  mode,
  segments = [],
  chapters = [],
  badge,
  onTime,
  seekTo,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSeek = useRef<{ src: string; duration: number; request?: { time: number } }>({
    src,
    duration: givenDuration,
  });
  const [sourceTime, setSourceTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fileDuration, setFileDuration] = useState<{ src: string; seconds: number }>();
  const isCleanedPreview = mode === "cleaned-preview";
  // A played file knows its own length; the given duration covers the time before metadata loads.
  const duration =
    mode === "file" && fileDuration?.src === src ? fileDuration.seconds : givenDuration;
  const displayDuration = isCleanedPreview ? outputLength(duration, segments) : duration;
  const displayTime = isCleanedPreview ? toOutputTime(sourceTime, segments) : sourceTime;
  const activeSpeed = isCleanedPreview ? speedAt(sourceTime, segments) : undefined;
  const activeRemoved = mode === "file" ? removedAt(sourceTime, segments) : undefined;
  const hasHold = segments.some((segment) => segment.kind === "hold");

  function seekSource(time: number) {
    const video = videoRef.current;
    const next = clamp(time, duration);
    if (video) video.currentTime = next;
    if (video && !isCleanedPreview) video.playbackRate = 1;
    setSourceTime(next);
    onTime?.(next);
  }

  function seekDisplay(time: number) {
    const bounded = clamp(time, displayDuration);
    seekSource(isCleanedPreview ? toSourceTime(bounded, segments) : bounded);
  }

  function seekBy(delta: number) {
    seekDisplay(displayTime + delta);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
      setPlaying(false);
    } else {
      setPlaying(true);
      void video.play().catch(() => setPlaying(false));
    }
  }

  function handleVideoKeyDown(event: KeyboardEvent<HTMLVideoElement>) {
    if (event.key === " " || event.key.toLowerCase() === "k") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-5);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(5);
    }
  }

  function handleSeekChange(event: ChangeEvent<HTMLInputElement>) {
    seekDisplay(Number(event.currentTarget.value));
  }

  useEffect(() => {
    if (seekTo === undefined) {
      lastSeek.current = { src, duration };
      return;
    }
    if (
      lastSeek.current.src === src &&
      lastSeek.current.duration === duration &&
      lastSeek.current.request === seekTo
    ) {
      return;
    }
    lastSeek.current = { src, duration, request: seekTo };
    const time = clamp(seekTo.time, duration);
    if (videoRef.current) videoRef.current.currentTime = time;
    setSourceTime(time);
    onTime?.(time);
  }, [seekTo, src, duration, onTime]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isCleanedPreview) video.playbackRate = 1;
    const update = () => {
      let time = video.currentTime;
      if (isCleanedPreview) {
        const removed = removedAt(time, segments);
        if (removed) {
          time = removed.end;
          video.currentTime = time;
        }
        const speed = speedAt(time, segments)?.speed;
        video.playbackRate = speed && Number.isFinite(speed) && speed > 0 ? speed : 1;
      } else {
        video.playbackRate = 1;
      }
      setSourceTime(time);
      onTime?.(time);
    };
    video.addEventListener("timeupdate", update);
    video.addEventListener("seeked", update);

    let frameId: number | undefined;
    if ("requestVideoFrameCallback" in video) {
      const onFrame = () => {
        update();
        frameId = video.requestVideoFrameCallback(onFrame);
      };
      frameId = video.requestVideoFrameCallback(onFrame);
    }
    return () => {
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("seeked", update);
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
    };
  }, [mode, segments, onTime, duration, isCleanedPreview]);

  const hint = isCleanedPreview
    ? "of the cleaned video · skips removed parts"
    : "of your original recording";

  return (
    <section aria-label="Video preview" className="flex flex-col gap-3">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-player">
        <video
          ref={videoRef}
          aria-label={badge ?? "Video player"}
          src={src}
          tabIndex={0}
          preload="metadata"
          className="size-full object-contain focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white"
          onKeyDown={handleVideoKeyDown}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) setFileDuration({ src, seconds });
          }}
        />
        {badge ? (
          <span className="pointer-events-none absolute left-3 top-3 rounded-lg bg-ink/75 px-2.5 py-1 text-xs font-medium text-white">
            {badge}
          </span>
        ) : null}
        {activeSpeed?.speed ? (
          <span className="pointer-events-none absolute right-3 top-3 rounded-lg bg-accent-soft px-2.5 py-1 text-xs font-medium text-ink">
            {formatRate(activeSpeed.speed)}×
          </span>
        ) : null}
        {activeRemoved ? (
          <span className="absolute inset-x-3 bottom-3 rounded-lg bg-ink/80 px-3 py-2 text-center text-xs font-medium text-white">
            Removed in the cleaned version · {activeRemoved.label.toLowerCase()}
          </span>
        ) : null}
      </div>

      {hasHold ? <p className="m-0 text-xs text-muted">Hold applied when rendered</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          aria-label="Back 5 seconds"
          onClick={() => seekBy(-5)}
          className="size-11 px-0"
        >
          <Rewind size={18} aria-hidden="true" />
        </Button>
        <Button
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          onClick={togglePlayback}
          className="size-11 px-0"
        >
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </Button>
        <Button
          variant="secondary"
          aria-label="Forward 5 seconds"
          onClick={() => seekBy(5)}
          className="size-11 px-0"
        >
          <FastForward size={18} aria-hidden="true" />
        </Button>
        <p className="m-0 min-w-0 flex-1 font-mono text-sm tabular-nums text-muted">
          {formatClock(displayTime)} {hint}
        </p>
      </div>

      <div role="group" aria-label="Video position" className="relative flex h-11 items-center">
        <div aria-hidden="true" className="absolute inset-x-0 h-1 rounded-full bg-line" />
        <div
          aria-hidden="true"
          className="absolute left-0 h-1 rounded-full bg-ink"
          style={{ width: `${percent(displayTime, displayDuration)}%` }}
        />
        {mode === "file"
          ? segments
              .filter((segment) => segment.kind === "removed")
              .map((segment) => (
                <div
                  key={`${segment.start}-${segment.end}-${segment.label}`}
                  aria-label={`Removed in the cleaned version · ${segment.label.toLowerCase()}`}
                  title={`${segment.label} · ${formatClock(segment.start)} to ${formatClock(segment.end)}`}
                  className="pointer-events-none absolute inset-y-0 z-10 border-x border-line-strong"
                  style={{
                    left: `${percent(segment.start, duration)}%`,
                    width: `${Math.max(0.5, percent(segment.end - segment.start, duration))}%`,
                    backgroundImage:
                      "repeating-linear-gradient(45deg, var(--color-line-strong) 0 4px, transparent 4px 8px)",
                  }}
                />
              ))
          : null}
        <input
          type="range"
          role="slider"
          aria-label="Seek"
          aria-valuetext={`${formatClock(displayTime)} of ${formatClock(displayDuration)}`}
          min={0}
          max={displayDuration}
          step={0.1}
          value={clamp(displayTime, displayDuration)}
          onChange={handleSeekChange}
          className={cx(
            "absolute inset-x-0 z-20 h-full w-full cursor-pointer appearance-none bg-transparent",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
            "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink",
            "[&::-webkit-slider-thumb]:shadow-[0_0_0_2px_white]",
            "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full",
            "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-ink",
          )}
        />
        {chapters.map((chapter) => {
          const chapterTime = isCleanedPreview
            ? toOutputTime(chapter.start, segments)
            : chapter.start;
          return (
            <button
              key={`${chapter.title}-${chapter.start}`}
              type="button"
              aria-label={`Jump to ${chapter.title} at ${formatClock(chapter.start)}`}
              title={chapter.title}
              onClick={() => seekSource(chapter.start)}
              className="absolute top-0 z-30 flex size-11 -translate-x-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
              style={{ left: `${percent(chapterTime, displayDuration)}%` }}
            >
              <span aria-hidden="true" className="size-2 rounded-full bg-ink-2 ring-2 ring-white" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
