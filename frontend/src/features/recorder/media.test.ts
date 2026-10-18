import { describe, expect, it, vi } from "vitest";
import { CaptureCancelledError, openMic, pickMimeType, startCapture, type MediaEnv } from "./media";

class FakeTrack {
  readyState: "live" | "ended" = "live";
  private listeners: Record<string, (() => void)[]> = {};
  constructor(
    public kind: "audio" | "video",
    private settings: MediaTrackSettings = {},
  ) {}
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  /** What Chrome does when the user clicks "Stop sharing". */
  endFromBrowser() {
    this.readyState = "ended";
    (this.listeners.ended ?? []).forEach((f) => f());
  }
  getSettings() {
    return this.settings;
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks = () => this.tracks;
  getVideoTracks = () => this.tracks.filter((t) => t.kind === "video");
  getAudioTracks = () => this.tracks.filter((t) => t.kind === "audio");
}

class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: FakeStream,
    public options: MediaRecorderOptions,
  ) {}
  start = vi.fn(() => {
    this.state = "recording";
  });
  pause = vi.fn(() => {
    this.state = "paused";
  });
  resume = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["abc"], { type: "video/webm" }) });
    this.onstop?.();
  });
}

function setup(opts: { displayAudio?: boolean; displayError?: Error; supported?: string[] } = {}) {
  const video = new FakeTrack("video", { width: 1920, height: 1080 });
  const displayTracks = [video, ...(opts.displayAudio ? [new FakeTrack("audio")] : [])];
  const micTrack = new FakeTrack("audio");
  const mixedTrack = new FakeTrack("audio");
  const sources: unknown[] = [];
  const ctx = {
    state: "running",
    createMediaStreamSource: vi.fn((s: FakeStream) => {
      const node = { stream: s, connect: vi.fn() };
      sources.push(node);
      return node;
    }),
    createMediaStreamDestination: vi.fn(() => ({ stream: new FakeStream([mixedTrack]) })),
    createAnalyser: vi.fn(() => ({
      fftSize: 0,
      getByteTimeDomainData: (arr: Uint8Array) => arr.fill(192),
      connect: vi.fn(),
    })),
    close: vi.fn(async () => {
      ctx.state = "closed";
    }),
  };
  const recorders: FakeRecorder[] = [];
  const env: MediaEnv = {
    getDisplayMedia: vi.fn(async () => {
      if (opts.displayError) throw opts.displayError;
      return new FakeStream(displayTracks) as unknown as MediaStream;
    }),
    getUserMedia: vi.fn(async () => new FakeStream([micTrack]) as unknown as MediaStream),
    createAudioContext: () => ctx as unknown as AudioContext,
    createMediaStream: (tracks) =>
      new FakeStream(tracks as unknown as FakeTrack[]) as unknown as MediaStream,
    createRecorder: (stream, options) => {
      const r = new FakeRecorder(stream as unknown as FakeStream, options);
      recorders.push(r);
      return r as unknown as MediaRecorder;
    },
    isTypeSupported: (t) =>
      (opts.supported ?? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"]).includes(t),
  };
  return { env, video, displayTracks, micTrack, mixedTrack, ctx, recorders, sources };
}

describe("pickMimeType", () => {
  it("prefers vp9 and falls back to vp8", () => {
    expect(pickMimeType((t) => t.includes("vp9") || t.includes("vp8"))).toBe(
      "video/webm;codecs=vp9,opus",
    );
    expect(pickMimeType((t) => t.includes("vp8"))).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});

describe("openMic", () => {
  it("requests the chosen device and reports a level between 0 and 1", async () => {
    const { env, micTrack, ctx } = setup();
    const mic = await openMic("dev-1", env);
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "dev-1" } } });
    expect(mic.level()).toBeGreaterThan(0);
    expect(mic.level()).toBeLessThanOrEqual(1);
    mic.close();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });
});

describe("startCapture", () => {
  it("asks for display video+audio and records video plus one mixed audio track", async () => {
    const s = setup({ displayAudio: true });
    const mic = await openMic(undefined, s.env);
    s.sources.length = 0; // ignore the meter source from openMic
    const cap = await startCapture({ mic: mic.stream, onShareEnded: vi.fn(), env: s.env });
    expect(s.env.getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.anything(), audio: true }),
    );
    expect(cap.hasDisplayAudio).toBe(true);
    const rec = s.recorders[0];
    expect(rec.options.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(rec.stream.tracks).toEqual([s.video, s.mixedTrack]);
    expect(s.sources).toHaveLength(2); // mic + display audio feed the mixer
    expect(rec.start).toHaveBeenCalled();
    expect(cap.width).toBe(1920);
    expect(cap.height).toBe(1080);
  });

  it("reports missing display audio and mixes the mic alone", async () => {
    const s = setup({ displayAudio: false });
    const mic = await openMic(undefined, s.env);
    s.sources.length = 0; // ignore the meter source from openMic
    const cap = await startCapture({ mic: mic.stream, onShareEnded: vi.fn(), env: s.env });
    expect(cap.hasDisplayAudio).toBe(false);
    expect(s.sources).toHaveLength(1);
  });

  it("stop() resolves the blob and stops every display track", async () => {
    const s = setup({ displayAudio: true });
    const cap = await startCapture({ mic: null, onShareEnded: vi.fn(), env: s.env });
    const blob = await cap.stop();
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("video/webm");
    s.displayTracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    expect(s.mixedTrack.stop).toHaveBeenCalled();
    expect(s.ctx.close).toHaveBeenCalled();
  });

  it("calls onShareEnded when the user stops sharing from the browser bar", async () => {
    const s = setup();
    const onShareEnded = vi.fn();
    await startCapture({ mic: null, onShareEnded, env: s.env });
    s.video.endFromBrowser();
    expect(onShareEnded).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops tracks without a pending stop", async () => {
    const s = setup({ displayAudio: true });
    const cap = await startCapture({ mic: null, onShareEnded: vi.fn(), env: s.env });
    cap.dispose();
    s.displayTracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    expect(s.recorders[0].stop).toHaveBeenCalled();
  });

  it("maps a dismissed share picker to CaptureCancelledError", async () => {
    const s = setup({ displayError: new DOMException("denied", "NotAllowedError") });
    await expect(
      startCapture({ mic: null, onShareEnded: vi.fn(), env: s.env }),
    ).rejects.toBeInstanceOf(CaptureCancelledError);
  });

  it("stops display tracks if the recorder cannot be created", async () => {
    const s = setup({ displayAudio: true });
    s.env.createRecorder = () => {
      throw new Error("unsupported");
    };
    await expect(startCapture({ mic: null, onShareEnded: vi.fn(), env: s.env })).rejects.toThrow(
      "unsupported",
    );
    s.displayTracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
    expect(s.ctx.close).toHaveBeenCalled();
  });

  it("pause and resume drive the recorder", async () => {
    const s = setup();
    const cap = await startCapture({ mic: null, onShareEnded: vi.fn(), env: s.env });
    cap.pause();
    expect(s.recorders[0].state).toBe("paused");
    cap.resume();
    expect(s.recorders[0].state).toBe("recording");
  });
});
