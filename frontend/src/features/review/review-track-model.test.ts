import { describe, expect, it } from "vitest";
import demo from "../../../e2e/fixtures/proposal-demo.json";
import type { components } from "@/api/generated/schema";
import { buildReviewTracks, playerSegmentsFromEntries } from "./review-track-model";

type ProposalView = components["schemas"]["ProposalView"];
const fixture = demo as unknown as ProposalView;

describe("review track model", () => {
  it("builds the four demo tracks with chapters, screen edits, spots, narration and waveform", () => {
    const tracks = buildReviewTracks({
      duration: 372,
      voice: "ai",
      entries: fixture.proposal.edit_plan.entries,
      changes: fixture.changes,
      spots: fixture.spots,
      chapters: fixture.chapters,
      keyframes: fixture.keyframes,
      scriptLines: fixture.script_lines,
      waveform: { rate: 50, peaks: [0.1, 0.7, 0.35] },
    });

    expect(tracks.map((track) => track.label)).toEqual([
      "Chapters",
      "Screen",
      "AI voice",
      "Your voice",
    ]);
    expect(tracks[0]?.items).toHaveLength(4);
    expect(tracks[1]?.items.filter((item) => item.thumbnailUrl)).toHaveLength(8);
    expect(tracks[1]?.items.filter((item) => item.kind === "removed")).toHaveLength(6);
    expect(tracks[1]?.items.find((item) => item.kind === "speed")?.text).toBe("2×");
    expect(tracks[1]?.items.filter((item) => item.kind === "needs-you")).toHaveLength(3);
    expect(tracks[2]?.items.find((item) => item.kind === "overflow")?.text).toBe("+4 s");
    expect(tracks[3]?.waveform).toEqual({ rate: 50, peaks: [0.1, 0.7, 0.35] });
    expect(tracks[3]?.items.filter((item) => item.kind === "faded")).toHaveLength(6);
    expect(tracks[3]?.dimmed).toBe(true);
    const publicLabels = tracks.flatMap((track) =>
      track.items.map((item) => `${item.text ?? ""} ${item.ariaLabel}`),
    );
    expect(publicLabels.join(" ")).not.toMatch(/spot-narration|pause-1|block-create/);
  });

  it("omits the AI voice track in my-voice mode and fades only removed source spans", () => {
    const tracks = buildReviewTracks({
      duration: 372,
      voice: "original",
      entries: fixture.proposal.edit_plan.entries,
      changes: fixture.changes,
      spots: fixture.spots,
      chapters: fixture.chapters,
      keyframes: fixture.keyframes,
      scriptLines: fixture.script_lines,
      waveform: null,
    });

    expect(tracks.map((track) => track.label)).toEqual(["Chapters", "Screen", "Your voice"]);
    expect(tracks[2]).toMatchObject({ sublabel: "removed parts shown faded", dimmed: false });
    expect(tracks[2]?.waveform).toBeNull();
  });

  it("removes an undone cut from the timeline immediately", () => {
    const entries = fixture.proposal.edit_plan.entries.map((entry) =>
      entry.seg_id === "pause-1" ? { ...entry, action: "keep" as const } : entry,
    );
    const tracks = buildReviewTracks({
      duration: 372,
      voice: "original",
      entries,
      changes: fixture.changes,
      spots: fixture.spots,
      chapters: fixture.chapters,
      keyframes: fixture.keyframes,
      scriptLines: fixture.script_lines,
      waveform: null,
    });

    expect(tracks[1]?.items.some((item) => item.id === "change-pause-1")).toBe(false);
    expect(tracks[2]?.items.some((item) => item.start === 10 && item.end === 30)).toBe(false);
  });

  it("builds cleaned-preview segments from the current EDL, including undo state", () => {
    const entries = fixture.proposal.edit_plan.entries.map((entry) =>
      entry.seg_id === "pause-1" ? { ...entry, action: "keep" as const } : entry,
    );
    const segments = playerSegmentsFromEntries(entries, fixture.changes);

    expect(segments).toHaveLength(7);
    expect(segments.some((segment) => segment.start === 10 && segment.end === 30)).toBe(false);
    expect(segments.filter((segment) => segment.kind === "removed")).toHaveLength(5);
    expect(segments.filter((segment) => segment.kind === "speed")).toHaveLength(2);
  });
});
