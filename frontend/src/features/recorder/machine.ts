/** Pure recorder state machine: idle -> choosing -> recording <-> paused -> stopping -> recorded | error. */

export const MAX_RECORDING_MS = 15 * 60 * 1000;

export type RecorderStatus =
  "idle" | "choosing" | "recording" | "paused" | "stopping" | "recorded" | "error";
export type StopReason = "user" | "limit" | "share-ended";

export type RecorderState = {
  status: RecorderStatus;
  elapsedMs: number;
  /** The display stream arrived without an audio track (tab/system audio not shared). */
  noTabAudio: boolean;
  stopReason: StopReason | null;
  error: string | null;
};

export type RecorderEvent =
  | { type: "START" }
  | { type: "CANCEL" }
  | { type: "STREAM_READY"; hasDisplayAudio: boolean }
  | { type: "TICK"; deltaMs: number }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "SHARE_ENDED" }
  | { type: "RECORDER_STOPPED" }
  | { type: "FAIL"; message: string }
  | { type: "RESET" };

export const initialRecorderState: RecorderState = {
  status: "idle",
  elapsedMs: 0,
  noTabAudio: false,
  stopReason: null,
  error: null,
};

const live = (s: RecorderState) => s.status === "recording" || s.status === "paused";

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "START":
      return state.status === "idle" ? { ...initialRecorderState, status: "choosing" } : state;
    case "CANCEL":
      return state.status === "choosing" ? initialRecorderState : state;
    case "STREAM_READY":
      return state.status === "choosing"
        ? { ...state, status: "recording", elapsedMs: 0, noTabAudio: !event.hasDisplayAudio }
        : state;
    case "TICK": {
      if (state.status !== "recording" || event.deltaMs <= 0) return state;
      const elapsedMs = state.elapsedMs + event.deltaMs;
      if (elapsedMs >= MAX_RECORDING_MS) {
        return { ...state, status: "stopping", elapsedMs: MAX_RECORDING_MS, stopReason: "limit" };
      }
      return { ...state, elapsedMs };
    }
    case "PAUSE":
      return state.status === "recording" ? { ...state, status: "paused" } : state;
    case "RESUME":
      return state.status === "paused" ? { ...state, status: "recording" } : state;
    case "STOP":
      return live(state) ? { ...state, status: "stopping", stopReason: "user" } : state;
    case "SHARE_ENDED":
      return live(state) ? { ...state, status: "stopping", stopReason: "share-ended" } : state;
    case "RECORDER_STOPPED":
      return state.status === "stopping" ? { ...state, status: "recorded" } : state;
    case "FAIL":
      return { ...state, status: "error", error: event.message };
    case "RESET":
      return state.status === "recorded" || state.status === "error" ? initialRecorderState : state;
  }
}

export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
