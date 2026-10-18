/**
 * Browser capture: display (screen/tab/window) + microphone, mixed through an
 * AudioContext into one MediaRecorder stream. Every exit path stops the tracks.
 */

export interface MediaEnv {
  getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createMediaStream(tracks: MediaStreamTrack[]): MediaStream;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(mimeType: string): boolean;
}

export function browserMediaEnv(): MediaEnv {
  return {
    getDisplayMedia: (c) => navigator.mediaDevices.getDisplayMedia(c),
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createAudioContext: () => new AudioContext(),
    createMediaStream: (tracks) => new MediaStream(tracks),
    createRecorder: (stream, options) => new MediaRecorder(stream, options),
    isTypeSupported: (t) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  };
}

export const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export function pickMimeType(isSupported: (mime: string) => boolean): string | undefined {
  return MIME_CANDIDATES.find((m) => isSupported(m));
}

export class CaptureCancelledError extends Error {
  constructor() {
    super("Screen sharing was cancelled");
    this.name = "CaptureCancelledError";
  }
}

const stopAll = (stream: MediaStream | null | undefined) =>
  stream?.getTracks().forEach((t) => t.stop());

const closeCtx = (ctx: AudioContext) => {
  if (ctx.state !== "closed") void ctx.close().catch(() => undefined);
};

export type MicHandle = {
  stream: MediaStream;
  /** RMS level of the latest audio frame, 0..1. */
  level(): number;
  close(): void;
};

export async function openMic(
  deviceId: string | undefined,
  env: MediaEnv = browserMediaEnv(),
): Promise<MicHandle> {
  const stream = await env.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  const ctx = env.createAudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(512);
  return {
    stream,
    level() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      return Math.min(1, Math.sqrt(sum / buf.length));
    },
    close() {
      stopAll(stream);
      closeCtx(ctx);
    },
  };
}

export type Capture = {
  hasDisplayAudio: boolean;
  /** The shared display stream, for a muted live preview. */
  preview: MediaStream;
  width?: number;
  height?: number;
  mimeType: string;
  pause(): void;
  resume(): void;
  /** Stops recording, releases display tracks, resolves the recorded file. */
  stop(): Promise<Blob>;
  /** Releases everything without waiting for data (unmount, errors). */
  dispose(): void;
};

export type StartCaptureOptions = {
  /** Microphone stream from openMic; the caller keeps ownership of it. */
  mic: MediaStream | null;
  /** Fired when the user ends sharing from the browser's own "Stop sharing" bar. */
  onShareEnded: () => void;
  /** Ask the browser to share tab/system audio too (default true). */
  captureSystemAudio?: boolean;
  /** Fired on each ~1 s recorder chunk. Driven by the media pipeline, so it keeps firing in a hidden tab. */
  onData?: () => void;
  env?: MediaEnv;
};

export async function startCapture({
  mic,
  onShareEnded,
  captureSystemAudio = true,
  onData,
  env = browserMediaEnv(),
}: StartCaptureOptions): Promise<Capture> {
  let display: MediaStream;
  try {
    display = await env.getDisplayMedia({ video: { frameRate: 30 }, audio: captureSystemAudio });
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "NotAllowedError" || err.name === "AbortError")
    ) {
      throw new CaptureCancelledError();
    }
    throw err;
  }

  const ctx = env.createAudioContext();
  let mixed: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | undefined;
  const handleEnded = () => onShareEnded();

  const release = () => {
    videoTrack?.removeEventListener("ended", handleEnded);
    stopAll(display);
    stopAll(mixed);
    closeCtx(ctx);
  };

  try {
    videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) throw new Error("No video track was shared");
    const hasDisplayAudio = display.getAudioTracks().length > 0;

    const dest = ctx.createMediaStreamDestination();
    if (mic && mic.getAudioTracks().length > 0) ctx.createMediaStreamSource(mic).connect(dest);
    if (hasDisplayAudio) ctx.createMediaStreamSource(display).connect(dest);
    mixed = dest.stream;

    const mimeType = pickMimeType((m) => env.isTypeSupported(m)) ?? "video/webm";
    const recorder = env.createRecorder(
      env.createMediaStream([videoTrack, ...mixed.getAudioTracks()]),
      { mimeType },
    );
    const chunks: Blob[] = [];
    let stopped: Promise<Blob> | null = null;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
      onData?.();
    };

    videoTrack.addEventListener("ended", handleEnded);
    recorder.start(1000);

    const { width, height } = videoTrack.getSettings();
    return {
      hasDisplayAudio,
      preview: display,
      width,
      height,
      mimeType,
      pause: () => recorder.state === "recording" && recorder.pause(),
      resume: () => recorder.state === "paused" && recorder.resume(),
      stop() {
        stopped ??= new Promise<Blob>((resolve, reject) => {
          const done = () => {
            release();
            resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
          };
          if (recorder.state === "inactive") return done();
          recorder.onstop = done;
          recorder.onerror = () => {
            release();
            reject(new Error("Recording failed"));
          };
          recorder.stop();
        });
        return stopped;
      },
      dispose() {
        if (recorder.state !== "inactive") {
          recorder.onstop = null;
          recorder.stop();
        }
        release();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

/** Poster width: big enough for a library card or the player's poster, small as a JPEG. */
export const POSTER_WIDTH = 1280;

/**
 * Copies the frame the preview shows right now into a JPEG (about 1280 px wide).
 * The draw is synchronous, so call it before the preview stream is detached.
 * Resolves null when there is no frame or the browser cannot encode one.
 */
export function grabPoster(
  video: HTMLVideoElement,
  doc: Document = document,
): Promise<Blob | null> {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return Promise.resolve(null);
  const scale = Math.min(1, POSTER_WIDTH / w);
  const canvas = doc.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
}
