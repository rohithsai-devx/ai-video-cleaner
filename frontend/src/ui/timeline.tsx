"use client";

/* eslint-disable @next/next/no-img-element -- timeline thumbnails are decorative and lazy-loaded. */

import { useId, type ChangeEvent, type KeyboardEvent } from "react";
import { formatClock } from "@/lib/clock";
import { cx } from "./cx";

export type TimelineItem = {
  id: string;
  start: number;
  end: number;
  kind: string;
  text?: string;
  ariaLabel: string;
  thumbnailUrl?: string | null;
};

export type WaveformData = { rate: number; peaks: number[] };

export type TimelineTrack = {
  id: string;
  label: string;
  sublabel: string;
  items: TimelineItem[];
  /** Omit for tracks without audio; pass null when a waveform should be shown but is unavailable. */
  waveform?: WaveformData | null;
};

export type TimelineProps = {
  duration: number;
  playhead: number;
  tracks: TimelineTrack[];
  selectedId?: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string) => void;
};

const ITEM_TONE: Record<string, string> = {
  removed: "border-dashed border-line-strong bg-sunken text-ink",
  speed: "border-accent-strong bg-accent-soft text-ink",
  "needs-you": "border-flag bg-flag-soft text-ink",
  spot: "border-flag bg-flag-soft text-ink",
};

function clamp(value: number, duration: number): number {
  return Math.min(duration, Math.max(0, Number.isFinite(value) ? value : 0));
}

function percent(time: number, duration: number): number {
  return duration > 0 ? (clamp(time, duration) / duration) * 100 : 0;
}

function ticks(duration: number): number[] {
  const values = [0];
  for (let time = 60; time < duration; time += 60) values.push(time);
  if (duration > 0 && values.at(-1) !== duration) values.push(duration);
  return values;
}

function waveformPath(peaks: number[]): string {
  if (peaks.length === 0) return "";
  const values = peaks.map((peak) => (Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0));
  const last = Math.max(1, values.length - 1);
  const upper = values.map((peak, index) => `L ${(index / last) * 100} ${50 - peak * 46}`);
  const lower = values
    .map((peak, index) => [index, 50 + peak * 46] as const)
    .reverse()
    .map(([index, height]) => `L ${(index / last) * 100} ${height}`);
  return `M 0 50 ${upper.join(" ")} ${lower.join(" ")} Z`;
}

export function Timeline({
  duration,
  playhead,
  tracks,
  selectedId,
  onSeek,
  onSelect,
}: TimelineProps) {
  const id = useId();
  const currentTime = clamp(playhead, duration);
  const marks = ticks(duration);

  function handleRulerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const step = event.shiftKey ? 1 : 5;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onSeek(clamp(currentTime - step, duration));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onSeek(clamp(currentTime + step, duration));
    } else if (event.key === "Home") {
      event.preventDefault();
      onSeek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onSeek(duration);
    }
  }

  function handleRulerChange(event: ChangeEvent<HTMLInputElement>) {
    onSeek(clamp(Number(event.currentTarget.value), duration));
  }

  return (
    <section aria-label="Timeline" className="rounded-2xl border border-line bg-surface px-4 py-3">
      <div
        role="region"
        aria-label="Scrollable timeline tracks"
        tabIndex={0}
        className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <div className="grid min-w-[996px] grid-cols-[96px_minmax(900px,1fr)] gap-x-3">
          <div aria-hidden="true" />
          <div className="relative h-9">
            {marks.map((time) => (
              <span
                key={time}
                aria-hidden="true"
                className="absolute top-0 -translate-x-1/2 font-mono text-[11px] tabular-nums text-muted first:translate-x-0 last:-translate-x-full"
                style={{ left: `${percent(time, duration)}%` }}
              >
                {formatClock(time)}
              </span>
            ))}
            <div aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-line-strong" />
            {marks.map((time) => (
              <span
                key={`tick-${time}`}
                aria-hidden="true"
                className="absolute bottom-0 h-2 w-px bg-line-strong"
                style={{ left: `${percent(time, duration)}%` }}
              />
            ))}
            <input
              id={`${id}-playhead`}
              type="range"
              role="slider"
              aria-label="Timeline playhead"
              aria-valuetext={formatClock(currentTime)}
              min={0}
              max={duration}
              step={0.1}
              value={currentTime}
              onChange={handleRulerChange}
              onKeyDown={handleRulerKeyDown}
              className={cx(
                "absolute inset-0 z-20 h-full w-full cursor-pointer appearance-none bg-transparent",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent",
                "[&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent",
                "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none",
                "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-danger",
                "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full",
                "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-danger",
              )}
            />
          </div>

          {tracks.map((track) => (
            <div
              key={track.id}
              role="group"
              aria-label={`${track.label} track`}
              className="col-span-2 grid grid-cols-[96px_minmax(900px,1fr)] gap-x-3"
            >
              <div className="flex min-h-14 flex-col justify-center">
                <span className="text-xs font-medium text-ink-2">{track.label}</span>
                <span className="text-[11px] leading-tight text-muted">{track.sublabel}</span>
              </div>
              <div className="relative min-h-14 overflow-hidden border-b border-line">
                {track.waveform ? (
                  <svg
                    data-waveform="true"
                    aria-hidden="true"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="absolute inset-1 size-[calc(100%-0.5rem)]"
                  >
                    <path
                      d={waveformPath(track.waveform.peaks)}
                      fill="var(--color-accent-strong)"
                    />
                  </svg>
                ) : track.waveform === null ? (
                  <span className="absolute inset-0 flex items-center justify-center text-xs text-muted">
                    Waveform not available
                  </span>
                ) : null}

                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 z-10 w-px bg-danger"
                  style={{ left: `${percent(currentTime, duration)}%` }}
                />

                <div className="absolute inset-0">
                  {track.items.map((item) => {
                    const start = percent(item.start, duration);
                    const end = percent(item.end, duration);
                    const width = Math.max(0.5, end - start);
                    const selected = item.id === selectedId;
                    const tone = ITEM_TONE[item.kind] ?? "border-line-strong bg-surface text-ink";
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={item.ariaLabel}
                        aria-pressed={selected}
                        title={item.ariaLabel}
                        onClick={() => {
                          onSelect(item.id);
                          onSeek(item.start);
                        }}
                        className={cx(
                          "absolute top-1 z-20 flex min-h-11 items-center justify-center overflow-hidden rounded-md border px-1 text-[11px] leading-tight",
                          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
                          tone,
                          selected &&
                            "border-2 border-ink outline outline-1 outline-offset-1 outline-ink",
                        )}
                        style={{ left: `${start}%`, width: `${width}%` }}
                      >
                        {item.thumbnailUrl ? (
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            className="absolute inset-0 size-full object-cover"
                          />
                        ) : null}
                        {item.kind === "removed" ? (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0"
                            style={{
                              backgroundImage:
                                "repeating-linear-gradient(45deg, var(--color-line-strong) 0 4px, transparent 4px 8px)",
                            }}
                          />
                        ) : null}
                        <span className="relative truncate">{item.text}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
