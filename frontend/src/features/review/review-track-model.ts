import type { components } from "@/api/generated/schema";
import { formatClock } from "@/lib/clock";
import { segmentsFromChanges, type PlayerSegment } from "@/lib/cut-map";
import type { TimelineItem, TimelineTrack, WaveformData } from "@/ui/timeline";

type Entry = components["schemas"]["EDLEntry"];
type Change = components["schemas"]["Change"];
type Spot = components["schemas"]["Spot"];
type Chapter = components["schemas"]["Chapter"];
type Keyframe = components["schemas"]["KeyframeThumb"];
type ScriptLine = components["schemas"]["ScriptLine"];

export type ReviewTrackInput = {
  duration: number;
  voice: "ai" | "original";
  entries: Entry[];
  changes: Change[];
  spots: Spot[];
  chapters: Chapter[];
  keyframes: Keyframe[];
  scriptLines: ScriptLine[];
  waveform: WaveformData | null;
};

export function playerSegmentsFromEntries(entries: Entry[], changes: Change[]): PlayerSegment[] {
  const changeById = new Map(changes.map((change) => [change.change_id, change]));
  const activeChanges: Change[] = entries.flatMap((entry) => {
    if (entry.action === "keep") return [];
    const original = changeById.get(entry.seg_id);
    const kind: Change["kind"] =
      entry.action === "speed"
        ? "speed"
        : entry.action === "freeze"
          ? "hold"
          : original && original.kind !== "speed" && original.kind !== "hold"
            ? original.kind
            : "cut";
    return [
      {
        change_id: entry.seg_id,
        kind,
        span: [entry.src[0], entry.src[1]],
        speed: entry.action === "speed" ? entry.speed : null,
        hold_s: entry.action === "freeze" ? entry.freeze_s : null,
        reason: original?.reason ?? entry.reasoning,
        undone: false,
      },
    ];
  });
  return segmentsFromChanges(activeChanges);
}

function labelForEntry(entry: Entry, change: Change | undefined): string {
  if (change) {
    if (change.kind === "pause") return "Pause removed";
    if (change.kind === "filler") return "Filler word removed";
    if (change.kind === "retake") return "Retake removed";
    if (change.kind === "speed") return `Sped up ${entry.speed}×`;
    if (change.kind === "hold") return `Held last frame ${change.hold_s ?? 0} s`;
    return "Cut";
  }
  if (entry.action === "speed") return `Sped up ${entry.speed}×`;
  if (entry.action === "freeze") return `Held last frame ${entry.freeze_s} s`;
  return "Removed in the cleaned version";
}

function screenItems(
  duration: number,
  keyframes: Keyframe[],
  changes: Change[],
  spots: Spot[],
  entries: Entry[],
): TimelineItem[] {
  const frames = keyframes.slice().sort((a, b) => a.t - b.t);
  const items = frames.map((frame, index): TimelineItem => {
    const start = frame.t;
    const nextTime = frames[index + 1]?.t ?? duration;
    return {
      id: frame.frame_id,
      start,
      end: Math.max(start, nextTime),
      kind: "frame",
      ariaLabel: `Screen at ${formatClock(start)}`,
      thumbnailUrl: frame.url,
    };
  });
  const changeById = new Map(changes.map((change) => [change.change_id, change]));

  for (const entry of entries) {
    if (entry.action === "keep") continue;
    const change = changeById.get(entry.seg_id);
    const label = labelForEntry(entry, change);
    const kind = entry.action === "cut" ? "removed" : entry.action === "speed" ? "speed" : "hold";
    const text =
      entry.action === "speed"
        ? `${entry.speed}×`
        : entry.action === "freeze"
          ? `Hold ${entry.freeze_s} s`
          : "Removed";
    items.push({
      id: `change-${entry.seg_id}`,
      start: entry.src[0],
      end: entry.src[1],
      kind,
      text,
      ariaLabel: `${label}, ${formatClock(entry.src[0])} to ${formatClock(entry.src[1])}${change ? ` · ${change.reason}` : ""}`,
    });
  }

  for (const spot of spots) {
    items.push({
      id: `spot-${spot.spot_id}`,
      start: spot.span[0],
      end: spot.span[1],
      kind: "needs-you",
      text: "Needs you",
      ariaLabel: `${spot.question} · ${formatClock(spot.span[0])}`,
    });
  }

  return items;
}

export function buildReviewTracks({
  duration,
  voice,
  entries,
  changes,
  spots,
  chapters,
  keyframes,
  scriptLines,
  waveform,
}: ReviewTrackInput): TimelineTrack[] {
  const chapterTrack: TimelineTrack = {
    id: "chapters",
    label: "Chapters",
    sublabel: "Sections in this recording",
    items: chapters.map((chapter, index) => ({
      id: `chapter-${index}`,
      start: chapter.start,
      end: chapter.end,
      kind: "chapter",
      text: chapter.title,
      ariaLabel: `${chapter.title}, ${formatClock(chapter.start)} to ${formatClock(chapter.end)}`,
    })),
  };

  const screenTrack: TimelineTrack = {
    id: "screen",
    label: "Screen",
    sublabel: "cuts and speed-ups",
    items: screenItems(duration, keyframes, changes, spots, entries),
  };

  const tracks: TimelineTrack[] = [chapterTrack, screenTrack];

  if (voice === "ai") {
    const narrationItems: TimelineItem[] = [];
    for (const line of scriptLines) {
      narrationItems.push({
        id: `script-${line.block_id}`,
        start: line.start,
        end: line.end,
        kind: "voice-line",
        text: line.text,
        ariaLabel: `AI narration: ${line.text}`,
      });
      if (line.overflow_s > 0) {
        narrationItems.push({
          id: `overflow-${line.block_id}`,
          start: line.end,
          end: line.end + line.overflow_s,
          kind: "overflow",
          text: `+${line.overflow_s} s`,
          ariaLabel: `Narration continues ${line.overflow_s} seconds past this screen span`,
        });
      }
    }
    tracks.push({
      id: "ai-voice",
      label: "AI voice",
      sublabel: "new narration",
      items: narrationItems,
    });
  }

  const removedItems = entries
    .filter((entry) => entry.action === "cut")
    .map((entry): TimelineItem => ({
      id: `faded-${entry.seg_id}`,
      start: entry.src[0],
      end: entry.src[1],
      kind: "faded",
      ariaLabel: `Removed part, ${formatClock(entry.src[0])} to ${formatClock(entry.src[1])}`,
    }));
  tracks.push({
    id: "your-voice",
    label: "Your voice",
    sublabel: voice === "ai" ? "replaced by the AI voice" : "removed parts shown faded",
    items: removedItems,
    waveform,
    dimmed: voice === "ai",
  });

  return tracks;
}
