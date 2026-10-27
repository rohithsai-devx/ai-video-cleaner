import type { components } from "@/api/generated/schema";

export type PlayerSegment = {
  start: number;
  end: number;
  kind: "removed" | "speed" | "hold";
  speed?: number;
  /** Seconds the last frame of a hold is shown after the span plays. */
  holdS?: number;
  label: string;
};

type Change = components["schemas"]["Change"];

function ordered(segs: PlayerSegment[]): PlayerSegment[] {
  return segs
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end >= segment.start,
    )
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function holdOf(segment: PlayerSegment): number {
  return segment.holdS && Number.isFinite(segment.holdS) && segment.holdS > 0 ? segment.holdS : 0;
}

function rateOf(segment: PlayerSegment): number {
  return segment.speed && Number.isFinite(segment.speed) && segment.speed > 0 ? segment.speed : 1;
}

export function toOutputTime(t: number, segs: PlayerSegment[]): number {
  const sourceTime = Number.isFinite(t) ? Math.max(0, t) : 0;
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const segment of ordered(segs)) {
    const start = Math.max(sourceCursor, segment.start);
    const end = Math.max(start, segment.end);
    if (sourceTime < start) return outputCursor + sourceTime - sourceCursor;
    outputCursor += start - sourceCursor;

    if (segment.kind === "removed") {
      if (sourceTime < end) return outputCursor;
      sourceCursor = end;
      continue;
    }

    if (segment.kind === "speed") {
      const rate = rateOf(segment);
      if (sourceTime < end) return outputCursor + (sourceTime - start) / rate;
      outputCursor += (end - start) / rate;
      sourceCursor = end;
      continue;
    }

    // A hold plays its span, then shows the last frame for holdS more seconds.
    if (sourceTime < end) return outputCursor + sourceTime - start;
    outputCursor += end - start + holdOf(segment);
    sourceCursor = end;
  }

  return outputCursor + sourceTime - sourceCursor;
}

export function toSourceTime(t: number, segs: PlayerSegment[]): number {
  const outputTime = Number.isFinite(t) ? Math.max(0, t) : 0;
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const segment of ordered(segs)) {
    const start = Math.max(sourceCursor, segment.start);
    const end = Math.max(start, segment.end);
    const normalLength = start - sourceCursor;
    if (outputTime < outputCursor + normalLength) {
      return sourceCursor + outputTime - outputCursor;
    }
    outputCursor += normalLength;
    sourceCursor = start;

    if (segment.kind === "removed") {
      // The collapsed boundary belongs to the next kept source frame.
      sourceCursor = end;
      continue;
    }

    if (segment.kind === "speed") {
      const rate = rateOf(segment);
      const outputLength = (end - start) / rate;
      if (outputTime < outputCursor + outputLength) {
        return start + (outputTime - outputCursor) * rate;
      }
      outputCursor += outputLength;
      sourceCursor = end;
      continue;
    }

    const spanLength = end - start;
    if (outputTime < outputCursor + spanLength) {
      return start + outputTime - outputCursor;
    }
    const holdLength = holdOf(segment);
    // The held frame is the end of the span.
    if (outputTime < outputCursor + spanLength + holdLength) return end;
    outputCursor += spanLength + holdLength;
    sourceCursor = end;
  }

  return sourceCursor + outputTime - outputCursor;
}

export function outputLength(duration: number, segs: PlayerSegment[]): number {
  return toOutputTime(duration, segs);
}

export function segmentsFromChanges(changes: Change[]): PlayerSegment[] {
  return changes
    .filter((change) => !change.undone)
    .map((change) => {
      const [start, end] = change.span;
      const kind = change.kind === "speed" ? "speed" : change.kind === "hold" ? "hold" : "removed";
      const segment: PlayerSegment = { start, end, kind, label: change.reason };
      if (kind === "speed" && change.speed != null) segment.speed = change.speed;
      if (kind === "hold" && change.hold_s != null) segment.holdS = change.hold_s;
      return segment;
    });
}
