"use client";

import { CaretLeft, Pause, Play, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { uploadRecording, type UploadSession } from "@/api/upload";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Field } from "@/ui/field";
import {
  CaptureCancelledError,
  grabPoster,
  openMic,
  startCapture,
  type Capture,
  type MicHandle,
} from "./media";
import { MAX_RECORDING_MS, formatClock, initialRecorderState, recorderReducer } from "./machine";

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; sent: number; total: number }
  | { phase: "failed"; message: string }
  | { phase: "done" };

const LIMIT_LABEL = formatClock(MAX_RECORDING_MS);
const LIMIT_MINUTES = Math.round(MAX_RECORDING_MS / 60_000);

export function RecordScreen() {
  const router = useRouter();
  const [state, dispatch] = useReducer(recorderReducer, initialRecorderState);
  const [title, setTitle] = useState("Untitled recording");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [systemAudio, setSystemAudio] = useState(true);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string | undefined>(undefined);
  const [micError, setMicError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [upload, setUpload] = useState<UploadState>({ phase: "idle" });

  const micRef = useRef<MicHandle | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopStartedRef = useRef(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const durationRef = useRef(0);
  const sessionRef = useRef<UploadSession | null>(null);
  const posterRef = useRef<Promise<Blob | null>>(Promise.resolve(null));
  // Advances the clock; the interval drives it while visible, recorder chunks while the tab is hidden (timers throttle).
  const clockRef = useRef<() => void>(() => {});
  const [micEpoch, setMicEpoch] = useState(0);

  // Microphone for the level meter and the recording; reopened when the device changes.
  useEffect(() => {
    let cancelled = false;
    openMic(micId)
      .then(async (mic) => {
        if (cancelled) return mic.close();
        micRef.current?.close();
        micRef.current = mic;
        setMicError(null);
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setMics(devices.filter((d) => d.kind === "audioinput"));
      })
      .catch(() => {
        if (!cancelled)
          setMicError("Microphone is blocked. You can still record, but without narration.");
      });
    return () => {
      cancelled = true;
    };
  }, [micId, micEpoch]);

  // Mic level meter, sampled a few times a second.
  useEffect(() => {
    const id = window.setInterval(() => setLevel(micRef.current?.level() ?? 0), 120);
    return () => window.clearInterval(id);
  }, []);

  // Release every device and request on unmount.
  useEffect(
    () => () => {
      captureRef.current?.dispose();
      micRef.current?.close();
      abortRef.current?.abort();
    },
    [],
  );

  // Clock: only advances while recording; the reducer auto-stops at the limit.
  useEffect(() => {
    if (state.status !== "recording") return;
    let last = performance.now();
    const advance = () => {
      const now = performance.now();
      dispatch({ type: "TICK", deltaMs: now - last });
      last = now;
    };
    clockRef.current = advance;
    const id = window.setInterval(advance, 250);
    return () => {
      window.clearInterval(id);
      clockRef.current = () => {};
    };
  }, [state.status]);

  // Poster: keep a recent frame while recording. The preview <video> unmounts as soon as Stop is pressed,
  // so the frame cannot be grabbed at stop time.
  useEffect(() => {
    if (state.status !== "recording") return;
    const snap = () => {
      const video = previewRef.current;
      if (video && video.videoWidth > 0) posterRef.current = grabPoster(video).catch(() => null);
    };
    const first = window.setTimeout(snap, 1000);
    const id = window.setInterval(snap, 5000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [state.status]);

  const runUpload = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const capture = captureRef.current;
    setUpload({ phase: "uploading", sent: 0, total: blob.size });
    try {
      const poster = await posterRef.current.catch(() => null);
      const { videoId } = await uploadRecording({
        blob,
        poster,
        title: title.trim() || "Untitled recording",
        durationS: durationRef.current,
        width: capture?.width,
        height: capture?.height,
        signal: controller.signal,
        session: sessionRef.current ?? undefined,
        onSession: (s) => {
          sessionRef.current = s;
        },
        onProgress: (sent, total) => setUpload({ phase: "uploading", sent, total }),
      });
      setUpload({ phase: "done" });
      router.push(`/videos/${videoId}`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setUpload({ phase: "failed", message: (err as Error).message });
    }
  }, [router, title]);

  // Stopping: flush the recorder, release devices, then upload.
  useEffect(() => {
    if (state.status !== "stopping" || stopStartedRef.current) return;
    const capture = captureRef.current;
    if (!capture) return;
    stopStartedRef.current = true;
    durationRef.current = state.elapsedMs / 1000;
    capture
      .stop()
      .then((blob) => {
        blobRef.current = blob;
        micRef.current?.close();
        micRef.current = null;
        dispatch({ type: "RECORDER_STOPPED" });
        void runUpload();
      })
      .catch((err: Error) => dispatch({ type: "FAIL", message: err.message }));
  }, [state.status, state.elapsedMs, runUpload]);

  useEffect(() => {
    const video = previewRef.current;
    if (video)
      video.srcObject =
        state.status === "recording" || state.status === "paused"
          ? (captureRef.current?.preview ?? null)
          : null;
  }, [state.status]);

  async function start() {
    dispatch({ type: "START" });
    stopStartedRef.current = false;
    posterRef.current = Promise.resolve(null);
    try {
      const capture = await startCapture({
        mic: micRef.current?.stream ?? null,
        captureSystemAudio: systemAudio,
        onShareEnded: () => dispatch({ type: "SHARE_ENDED" }),
        onData: () => clockRef.current(),
      });
      captureRef.current = capture;
      dispatch({ type: "STREAM_READY", hasDisplayAudio: !systemAudio || capture.hasDisplayAudio });
    } catch (err) {
      if (err instanceof CaptureCancelledError) dispatch({ type: "CANCEL" });
      else
        dispatch({ type: "FAIL", message: (err as Error).message || "Could not start recording" });
    }
  }

  function togglePause() {
    const capture = captureRef.current;
    if (!capture) return;
    if (state.status === "recording") {
      capture.pause();
      dispatch({ type: "PAUSE" });
    } else {
      capture.resume();
      dispatch({ type: "RESUME" });
    }
  }

  function reset() {
    captureRef.current?.dispose();
    captureRef.current = null;
    blobRef.current = null;
    sessionRef.current = null; // a discarded take must never resume into its old video
    posterRef.current = Promise.resolve(null);
    setUpload({ phase: "idle" });
    dispatch({ type: "RESET" });
    setMicEpoch((n) => n + 1); // reopen the mic for the next take
  }

  const live = state.status === "recording" || state.status === "paused";
  const afterStop = state.status === "stopping" || state.status === "recorded";

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="flex h-16 items-center gap-4 border-b border-line bg-surface px-4 sm:px-8">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"
        >
          <CaretLeft size={16} aria-hidden />
          Library
        </Link>
        <span className="text-line-strong" aria-hidden>
          /
        </span>
        <span className="text-sm font-medium">New recording</span>
      </header>

      {state.status === "idle" || state.status === "choosing" ? (
        <main className="mx-auto flex max-w-[1120px] flex-wrap items-start gap-8 px-4 py-12 sm:px-8">
          <section className="flex min-w-0 flex-[1_1_420px] flex-col gap-5 rounded-3xl border border-line bg-surface p-6 sm:p-8">
            <div className="flex flex-col gap-1.5">
              <h1 className="font-display text-4xl">Record your screen</h1>
              <p className="text-[15px] leading-normal text-muted">
                Talk through it as you go. Mistakes and pauses are fine, the agent cleans them up.
              </p>
            </div>
            <Field
              label="Title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="flex flex-col gap-2">
              <label htmlFor="mic" className="text-sm font-medium">
                Microphone
              </label>
              <select
                id="mic"
                value={micId ?? ""}
                onChange={(e) => setMicId(e.target.value || undefined)}
                className="min-h-11 rounded-xl border border-line-strong bg-surface px-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {mics.length === 0 ? <option value="">Default microphone</option> : null}
                {mics.map((m, i) => (
                  <option key={m.deviceId || i} value={m.deviceId}>
                    {m.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>
              {micError ? (
                <p className="text-[13px] text-danger">{micError}</p>
              ) : (
                <MicMeter level={level} />
              )}
            </div>
            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={systemAudio}
                onChange={(e) => setSystemAudio(e.target.checked)}
                className="size-[18px] accent-ink"
              />
              Also capture tab or system audio
            </label>
            <Button onClick={start} disabled={state.status === "choosing"} className="h-12 gap-2.5">
              <span className="size-2.5 rounded-full bg-record" aria-hidden />
              {state.status === "choosing" ? "Waiting for Chrome…" : "Choose screen and record"}
            </Button>
            <p className="text-[13px] text-muted">
              Up to {LIMIT_MINUTES} minutes. Chrome will ask which tab, window or screen to share.
            </p>
          </section>
          <aside className="flex min-w-0 flex-[1_1_420px] flex-col gap-3" aria-hidden>
            <div className="text-[13px] text-muted">What Chrome shows next</div>
            <div className="flex flex-col gap-3.5 rounded-2xl border border-line-strong bg-surface p-5 shadow-[0_12px_32px_rgba(10,10,10,0.12)]">
              <div className="text-[15px] font-semibold">Choose what to share with Stepwise</div>
              <div className="flex gap-4 border-b border-line text-[13px]">
                <span className="border-b-2 border-[#1A73E8] pb-2 font-medium text-[#1A73E8]">
                  Chrome tab
                </span>
                <span className="pb-2 text-muted">Window</span>
                <span className="pb-2 text-muted">Entire screen</span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1.5 rounded-xl border-2 border-[#1A73E8] p-2">
                  <span className="aspect-video rounded bg-[#E8EDF5]" />
                  <span className="text-xs">Your app tab</span>
                </div>
                <div className="flex flex-col gap-1.5 rounded-xl border border-line p-2">
                  <span className="aspect-video rounded bg-sunken" />
                  <span className="text-xs text-muted">Another tab</span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="size-3.5 rounded-sm bg-[#1A73E8]" />
                Also share tab audio
              </div>
            </div>
          </aside>
        </main>
      ) : null}

      {live ? (
        <main className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 py-8 sm:px-8">
          {state.noTabAudio ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-2xl border border-flag bg-warning-soft px-4 py-3.5 text-sm leading-normal text-warning"
            >
              <Warning size={18} className="mt-0.5 flex-none" aria-hidden />
              <div>
                <strong className="font-semibold">No tab audio in this recording.</strong> Chrome
                shared the screen without sound. Your microphone is still recording, so narration is
                safe. To capture page audio, stop and tick &quot;Also share tab audio&quot;.
              </div>
            </div>
          ) : null}
          <div className="relative aspect-video overflow-hidden rounded-3xl bg-player">
            <video
              ref={previewRef}
              autoPlay
              muted
              playsInline
              className="size-full object-contain"
            />
            <span className="absolute left-4 top-4 rounded-md bg-ink/75 px-2 py-1 text-xs text-white">
              {state.status === "paused" ? "Paused" : "Live preview"}
            </span>
          </div>
          <div className="flex items-center gap-4 self-center rounded-full bg-ink py-2.5 pl-5 pr-3 text-white">
            <span
              className={`size-2.5 rounded-full bg-record ${state.status === "recording" ? "animate-pulse motion-reduce:animate-none" : ""}`}
              aria-hidden
            />
            <span
              className="font-mono text-[15px] tabular-nums"
              role="timer"
              aria-label="Recording time"
            >
              {formatClock(state.elapsedMs)} <span className="text-faint">/ {LIMIT_LABEL}</span>
            </span>
            <button
              type="button"
              onClick={togglePause}
              aria-label={state.status === "recording" ? "Pause" : "Resume"}
              className="inline-flex size-11 items-center justify-center rounded-full bg-ink-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {state.status === "recording" ? (
                <Pause size={16} weight="bold" />
              ) : (
                <Play size={16} weight="bold" />
              )}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "STOP" })}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-ink hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <span className="size-2.5 rounded-sm bg-danger" aria-hidden />
              Stop
            </button>
          </div>
        </main>
      ) : null}

      {afterStop ? (
        <main className="mx-auto flex max-w-[560px] flex-col gap-4 px-4 py-16 sm:px-8">
          <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-6 sm:p-8">
            <h1 aria-live="polite" className="font-display text-2xl">
              {upload.phase === "failed"
                ? "Upload paused"
                : upload.phase === "done"
                  ? "Uploaded"
                  : "Uploading your recording"}
            </h1>
            {state.stopReason === "limit" ? (
              <p className="text-sm text-muted">Recording stopped at the {LIMIT_LABEL} limit.</p>
            ) : state.stopReason === "share-ended" ? (
              <p className="text-sm text-muted">Sharing ended, so the recording stopped.</p>
            ) : null}
            <UploadBar upload={upload} />
            <p aria-live="polite" className="m-0 text-sm text-danger empty:hidden">
              {upload.phase === "failed" ? upload.message : ""}
            </p>
            {upload.phase === "failed" ? (
              <>
                <div className="flex gap-2">
                  <Button onClick={() => void runUpload()}>Try again</Button>
                  <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
                    Discard
                  </Button>
                </div>
                <ConfirmDialog
                  open={confirmDiscard}
                  title="Discard this recording?"
                  description="It has not finished uploading, so it will be gone for good."
                  confirmLabel="Discard recording"
                  cancelLabel="Keep it"
                  danger
                  onCancel={() => setConfirmDiscard(false)}
                  onConfirm={() => {
                    setConfirmDiscard(false);
                    reset();
                  }}
                />
              </>
            ) : (
              <p className="text-[13px] text-muted">
                Recorded {formatClock(state.elapsedMs)}. Keep this tab open until the upload
                finishes.
              </p>
            )}
          </section>
        </main>
      ) : null}

      {state.status === "error" ? (
        <main className="mx-auto flex max-w-[560px] flex-col gap-4 px-4 py-16 sm:px-8">
          <section
            role="alert"
            className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-6 sm:p-8"
          >
            <h1 className="font-display text-2xl">Recording stopped</h1>
            <p className="text-sm text-muted">{state.error}</p>
            <Button onClick={reset} className="self-start">
              Start over
            </Button>
          </section>
        </main>
      ) : null}
    </div>
  );
}

function MicMeter({ level }: { level: number }) {
  const bars = [0.35, 0.6, 0.9, 0.5, 0.75, 0.4];
  const lit = Math.round(Math.min(1, level * 4) * bars.length);
  return (
    <div className="flex h-[18px] items-end gap-[3px]" aria-label="Mic level">
      {bars.map((h, i) => (
        <span
          key={i}
          className={`w-1.5 rounded-sm ${i < lit ? "bg-ink" : "bg-[#DCD3F7]"}`}
          style={{ height: `${Math.round(6 + h * 10)}px` }}
        />
      ))}
      <span className="ml-2 text-[13px] text-muted">
        {lit > 0 ? "Picking up your voice" : "Say something to test"}
      </span>
    </div>
  );
}

function UploadBar({ upload }: { upload: UploadState }) {
  const pct =
    upload.phase === "uploading" && upload.total > 0
      ? Math.round((upload.sent / upload.total) * 100)
      : upload.phase === "done"
        ? 100
        : 0;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className="h-full rounded-full bg-ink transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[13px] tabular-nums text-muted">{pct}%</span>
    </div>
  );
}
