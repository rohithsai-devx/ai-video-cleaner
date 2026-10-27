import { describe, expect, it } from "vitest";
import type { components } from "@/api/generated/schema";
import { initialUndoState, undoReducer, type UndoState } from "./undo-model";

type Entry = components["schemas"]["EDLEntry"];
type Change = components["schemas"]["Change"];

const entry = (seg_id: string, action: Entry["action"], extra: Partial<Entry> = {}): Entry => ({
  seg_id,
  action,
  src: [12, 20],
  speed: 1,
  freeze_s: 0,
  reasoning: "The pause made the walkthrough harder to follow.",
  block_id: null,
  ...extra,
});

const change: Change = {
  change_id: "pause-segment",
  kind: "pause",
  span: [12, 20],
  speed: null,
  hold_s: null,
  reason: "The pause made the walkthrough harder to follow.",
  undone: false,
};

describe("undo model", () => {
  it("turns an applied change into a kept entry and restores its exact entry on redo", () => {
    const original = entry("pause-segment", "cut");
    const undone = undoReducer(initialUndoState, { type: "undo", change, current: original });
    expect(undone.entries[change.change_id]).toEqual({
      ...original,
      action: "keep",
      speed: 1,
      freeze_s: 0,
    });

    const redone = undoReducer(undone, {
      type: "redo",
      change,
      current: undone.entries[change.change_id]!,
    });
    expect(redone.entries[change.change_id]).toEqual(original);
    expect(redone.redoEntries).toEqual({});
  });

  it("reconstructs a saved undone speed or hold change when no session snapshot exists", () => {
    const savedUndone = {
      ...initialUndoState,
      entries: { "speed-segment": entry("speed-segment", "keep") },
    };
    const speedChange = {
      ...change,
      change_id: "speed-segment",
      kind: "speed" as const,
      speed: 2,
      undone: true,
    };
    const speed = undoReducer(savedUndone, {
      type: "redo",
      change: speedChange,
      current: savedUndone.entries["speed-segment"]!,
    });
    expect(speed.entries["speed-segment"]).toMatchObject({ action: "speed", speed: 2 });

    const holdChange = { ...change, kind: "hold" as const, hold_s: 4 };
    const hold = undoReducer(initialUndoState, {
      type: "redo",
      change: { ...holdChange, change_id: "hold-segment", undone: true },
      current: entry("hold-segment", "keep"),
    });
    expect(hold.entries["hold-segment"]).toMatchObject({ action: "freeze", freeze_s: 4 });
  });

  it("keeps changes to different entries independent", () => {
    const current = entry("another-segment", "speed", { speed: 2 });
    const otherChange = { ...change, change_id: current.seg_id, kind: "speed" as const, speed: 2 };
    const state: UndoState = undoReducer(initialUndoState, {
      type: "undo",
      change: otherChange,
      current,
    });
    expect(Object.keys(state.entries)).toEqual([current.seg_id]);
    expect(state.entries[current.seg_id]?.action).toBe("keep");
  });
});
