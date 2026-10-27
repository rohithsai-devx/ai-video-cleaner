import type { components } from "@/api/generated/schema";

type Entry = components["schemas"]["EDLEntry"];
type Change = components["schemas"]["Change"];

export type UndoState = {
  entries: Record<string, Entry>;
  redoEntries: Record<string, Entry>;
};

export type UndoAction =
  | { type: "undo"; change: Change; current: Entry }
  | { type: "redo"; change: Change; current: Entry }
  | { type: "forget"; changeId: string }
  | { type: "reset" };

export const initialUndoState: UndoState = { entries: {}, redoEntries: {} };

function restoreChange(change: Change, current: Entry): Entry {
  const sourceSpan: [number, number] = [change.span[0], change.span[1]];
  if (change.kind === "speed") {
    return {
      ...current,
      src: sourceSpan,
      action: "speed",
      speed: change.speed ?? 1,
      freeze_s: 0,
    };
  }
  if (change.kind === "hold") {
    return {
      ...current,
      src: sourceSpan,
      action: "freeze",
      speed: 1,
      freeze_s: change.hold_s ?? 0,
    };
  }
  return { ...current, src: sourceSpan, action: "cut", speed: 1, freeze_s: 0 };
}

export function undoReducer(state: UndoState, action: UndoAction): UndoState {
  if (action.type === "reset") return initialUndoState;
  if (action.type === "forget") {
    const redoEntries = { ...state.redoEntries };
    delete redoEntries[action.changeId];
    return { ...state, redoEntries };
  }

  const id = action.change.change_id;
  if (action.type === "undo") {
    return {
      entries: {
        ...state.entries,
        [id]: { ...action.current, action: "keep", speed: 1, freeze_s: 0 },
      },
      redoEntries: { ...state.redoEntries, [id]: action.current },
    };
  }

  const restored = state.redoEntries[id] ?? restoreChange(action.change, action.current);
  const redoEntries = { ...state.redoEntries };
  delete redoEntries[id];
  return {
    entries: { ...state.entries, [id]: restored },
    redoEntries,
  };
}
