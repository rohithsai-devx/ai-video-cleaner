import { describe, expect, it } from "vitest";
import {
  MAX_RECORDING_MS,
  formatClock,
  initialRecorderState,
  recorderReducer,
  type RecorderEvent,
  type RecorderState,
} from "./machine";

function run(events: RecorderEvent[], from: RecorderState = initialRecorderState): RecorderState {
  return events.reduce(recorderReducer, from);
}

const recording = (hasDisplayAudio = true) =>
  run([{ type: "START" }, { type: "STREAM_READY", hasDisplayAudio }]);

describe("recorderReducer", () => {
  it("starts idle", () => {
    expect(initialRecorderState).toMatchObject({ status: "idle", elapsedMs: 0, noTabAudio: false });
  });

  it("goes idle -> choosing -> recording", () => {
    const s1 = recorderReducer(initialRecorderState, { type: "START" });
    expect(s1.status).toBe("choosing");
    const s2 = recorderReducer(s1, { type: "STREAM_READY", hasDisplayAudio: true });
    expect(s2).toMatchObject({ status: "recording", elapsedMs: 0, noTabAudio: false });
  });

  it("returns to idle when the share picker is cancelled", () => {
    expect(run([{ type: "START" }, { type: "CANCEL" }]).status).toBe("idle");
  });

  it("flags noTabAudio when the display stream has no audio track", () => {
    expect(recording(false).noTabAudio).toBe(true);
    expect(recording(true).noTabAudio).toBe(false);
  });

  it("counts elapsed time only while recording", () => {
    const s = run(
      [
        { type: "TICK", deltaMs: 1000 },
        { type: "PAUSE" },
        { type: "TICK", deltaMs: 5000 },
        { type: "RESUME" },
        { type: "TICK", deltaMs: 500 },
      ],
      recording(),
    );
    expect(s).toMatchObject({ status: "recording", elapsedMs: 1500 });
  });

  it("toggles recording <-> paused", () => {
    const paused = recorderReducer(recording(), { type: "PAUSE" });
    expect(paused.status).toBe("paused");
    expect(recorderReducer(paused, { type: "RESUME" }).status).toBe("recording");
  });

  it("auto-stops at 15:00 and clamps the clock", () => {
    expect(MAX_RECORDING_MS).toBe(15 * 60 * 1000);
    const s = run(
      [
        { type: "TICK", deltaMs: MAX_RECORDING_MS - 10 },
        { type: "TICK", deltaMs: 50 },
      ],
      recording(),
    );
    expect(s).toMatchObject({
      status: "stopping",
      stopReason: "limit",
      elapsedMs: MAX_RECORDING_MS,
    });
  });

  it("stops on user stop from recording or paused", () => {
    expect(recorderReducer(recording(), { type: "STOP" })).toMatchObject({
      status: "stopping",
      stopReason: "user",
    });
    const paused = recorderReducer(recording(), { type: "PAUSE" });
    expect(recorderReducer(paused, { type: "STOP" })).toMatchObject({
      status: "stopping",
      stopReason: "user",
    });
  });

  it("stops when the user ends sharing from the browser bar", () => {
    expect(recorderReducer(recording(), { type: "SHARE_ENDED" })).toMatchObject({
      status: "stopping",
      stopReason: "share-ended",
    });
  });

  it("reaches recorded after the recorder flushes", () => {
    const s = run(
      [{ type: "TICK", deltaMs: 2000 }, { type: "STOP" }, { type: "RECORDER_STOPPED" }],
      recording(),
    );
    expect(s).toMatchObject({ status: "recorded", elapsedMs: 2000 });
  });

  it("moves to error from any state and resets to idle", () => {
    const err = recorderReducer(recording(), { type: "FAIL", message: "boom" });
    expect(err).toMatchObject({ status: "error", error: "boom" });
    expect(recorderReducer(err, { type: "RESET" })).toEqual(initialRecorderState);
  });

  it("ignores events that do not apply to the current state", () => {
    expect(recorderReducer(initialRecorderState, { type: "STOP" })).toBe(initialRecorderState);
    expect(recorderReducer(initialRecorderState, { type: "TICK", deltaMs: 1000 })).toBe(
      initialRecorderState,
    );
    const stopping = recorderReducer(recording(), { type: "STOP" });
    expect(recorderReducer(stopping, { type: "TICK", deltaMs: 1000 })).toBe(stopping);
    expect(recorderReducer(stopping, { type: "SHARE_ENDED" })).toBe(stopping);
  });
});

describe("formatClock", () => {
  it("formats mm:ss", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(252_400)).toBe("04:12");
    expect(formatClock(MAX_RECORDING_MS)).toBe("15:00");
  });
});
