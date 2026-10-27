import { describe, expect, it } from "vitest";
import { outputLength, segmentsFromChanges, toOutputTime, toSourceTime } from "./cut-map";

const segments = [
  { start: 10, end: 20, kind: "removed" as const, label: "Pause removed" },
  { start: 30, end: 50, kind: "speed" as const, speed: 2, label: "Wait sped up" },
];

describe("cut map", () => {
  it("maps source time through removed and sped-up intervals", () => {
    expect(toOutputTime(5, segments)).toBe(5);
    expect(toOutputTime(15, segments)).toBe(10);
    expect(toOutputTime(20, segments)).toBe(10);
    expect(toOutputTime(40, segments)).toBe(25);
    expect(toOutputTime(60, segments)).toBe(40);
  });

  it("maps cleaned positions back to the source, choosing the end of a cut", () => {
    expect(toSourceTime(10, segments)).toBe(20);
    expect(toSourceTime(25, segments)).toBe(40);
    expect(toSourceTime(40, segments)).toBe(60);
  });

  it("round-trips source positions outside removed spans", () => {
    for (const sourceTime of [0, 5, 9, 20, 25, 30, 35, 50, 51, 60, 100]) {
      expect(toSourceTime(toOutputTime(sourceTime, segments), segments)).toBe(sourceTime);
    }
  });

  it("computes output length and does not mutate segments", () => {
    const input = segments.slice().reverse();
    expect(outputLength(100, input)).toBe(80);
    expect(input[0].start).toBe(30);
  });

  it("keeps removed spans collapsed for positions inside them", () => {
    expect(toOutputTime(11, segments)).toBe(10);
    expect(toOutputTime(19.9, segments)).toBe(10);
    expect(toSourceTime(10, segments)).toBe(20);
  });

  it("builds segments from active changes and skips undone entries", () => {
    const changes: Parameters<typeof segmentsFromChanges>[0] = [
      {
        change_id: "pause-1",
        kind: "pause",
        span: [10, 20],
        speed: null,
        hold_s: null,
        reason: "A long pause was removed.",
        undone: false,
      },
      {
        change_id: "speed-1",
        kind: "speed",
        span: [30, 50],
        speed: 2,
        hold_s: null,
        reason: "A slow wait was sped up.",
        undone: false,
      },
      {
        change_id: "cut-1",
        kind: "cut",
        span: [60, 70],
        speed: null,
        hold_s: null,
        reason: "This cut was undone.",
        undone: true,
      },
      {
        change_id: "hold-1",
        kind: "hold",
        span: [80, 80],
        speed: null,
        hold_s: 4,
        reason: "The last frame was held.",
        undone: false,
      },
    ];

    expect(segmentsFromChanges(changes)).toEqual([
      { start: 10, end: 20, kind: "removed", label: "A long pause was removed." },
      { start: 30, end: 50, kind: "speed", speed: 2, label: "A slow wait was sped up." },
      { start: 80, end: 80, kind: "hold", label: "The last frame was held." },
    ]);
  });
});
