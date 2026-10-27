import type { components } from "@/api/generated/schema";

export type PlayerSegment = {
  start: number;
  end: number;
  kind: "removed" | "speed" | "hold";
  speed?: number;
  label: string;
};

type ChangeContract = {
  change_id: string;
  kind: "pause" | "filler" | "retake" | "cut" | "speed" | "hold";
  span: [number, number];
  speed?: number | null;
  hold_s?: number | null;
  reason: string;
  undone: boolean;
};

// BE-E adds this generated schema. Keep the contract shape available before that lands.
type Change = components["schemas"] extends { Change: infer T } ? T : ChangeContract;

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

    // Holds mark a frame on the source timeline; C9 carries no separate hold duration.
    if (sourceTime < end) return outputCursor + sourceTime - start;
    outputCursor += end - start;
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

    const holdLength = end - start;
    if (outputTime < outputCursor + holdLength) {
      return start + outputTime - outputCursor;
    }
    outputCursor += holdLength;
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
      return segment;
    });
}
